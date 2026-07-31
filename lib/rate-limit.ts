// Pacing for the Sheets/Drive calls in lib/sheets.ts.
//
// Google's per-user limits on sheets.googleapis.com are 60 read requests and 60
// write requests a minute, counted against the signed-in account rather than the
// whole project. A Pull reads the Products tab plus one tab per variable product,
// and a Push writes several calls per tab, so a catalogue of any size sails past
// 60 in a few seconds and Google answers 429 for the rest of the minute:
//
//   Quota exceeded for quota metric 'Read requests' and limit 'Read requests per
//   minute per user' of service 'sheets.googleapis.com'
//
// A token bucket smooths that out. It starts full, so a small catalogue is never
// slowed down at all; only once a run has spent its 60 does it settle to one call
// a second, which is exactly the rate Google will keep answering.
//
// Scope is this process. A serverless instance handles one request at a time, so
// this paces the burst that actually causes the 429 (all of one Pull's tab reads,
// or one Push step's writes). Two separate requests landing on two instances can
// still overlap; the 429 backoff in lib/sheets.ts is what covers that case, and
// between them a run recovers instead of failing.

export const REQUESTS_PER_MINUTE = 60

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Exported for the tests: the two buckets below are the only ones in use.
export class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  // Callers are served one at a time. Without this, ten concurrent readers would
  // all see the same token count, all decide there was room, and all go at once.
  private queue: Promise<void> = Promise.resolve()

  // `capacity` is the burst allowed from a standing start, `perMinute` the rate it
  // refills at. For Google's quota the two are the same number: 60 calls available
  // at once, replaced at 60 a minute. They are separable so the tests can exercise
  // a small burst against a fast refill.
  constructor(private readonly perMinute: number, private readonly capacity: number = perMinute) {
    this.tokens = capacity
    this.lastRefillMs = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const gained = ((now - this.lastRefillMs) * this.perMinute) / 60_000
    this.tokens = Math.min(this.capacity, this.tokens + gained)
    this.lastRefillMs = now
  }

  // Resolves when this caller may make its request, waiting only if the bucket is
  // empty. Never rejects.
  take(): Promise<void> {
    const turn = this.queue.then(async () => {
      this.refill()
      if (this.tokens < 1) {
        await sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute))
        this.refill()
      }
      this.tokens -= 1
    })
    this.queue = turn.catch(() => {})
    return turn
  }
}

// Google's default is 60 a minute, but the per-user quota is adjustable in the
// Google Cloud Console (IAM & Admin -> Quotas, sheets.googleapis.com). An owner
// who has had theirs raised tells the module through these env vars so the token
// buckets actually use the headroom; anything unset or nonsense stays at 60.
// Read once at module load, the same lifetime as the buckets themselves.
export function perMinuteFromEnv(raw: string | undefined, fallback: number = REQUESTS_PER_MINUTE): number {
  const n = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

// Google counts reads and writes against separate quotas, so they get separate
// buckets: a Push's writes must not slow down the reads it interleaves with them.
const readBucket = new TokenBucket(perMinuteFromEnv(process.env.GSP_SHEETS_READS_PER_MINUTE))
const writeBucket = new TokenBucket(perMinuteFromEnv(process.env.GSP_SHEETS_WRITES_PER_MINUTE))

export function awaitSlot(isRead: boolean): Promise<void> {
  return (isRead ? readBucket : writeBucket).take()
}

// How many times a rate-limited call is retried before the failure is handed back.
// Three retries spans roughly 1s + 2s + 4s of waiting, which clears a quota minute
// that was only just overrun without eating the whole request budget: every Sheets
// call runs inside a module route capped at 60 seconds.
export const MAX_BACKOFF_RETRIES = 3

// Longest wait we will honour from a Retry-After header. Anything beyond this and
// the run is better off failing with an explanation than sitting there silently
// until the platform kills it.
export const MAX_BACKOFF_MS = 10_000

// Whether a failed response is worth trying again.
//   429 - Google's rate limit. The request was refused outright, never executed,
//         so retrying it is safe whatever the method.
//   5xx - only retried on reads. A write that got a 500 may still have been
//         applied, and a repeated insertDimension or deleteDimension would move
//         the owner's columns twice.
export function shouldBackOff(status: number, isRead: boolean): boolean {
  return status === 429 || (isRead && status >= 500)
}

// How long to wait before retrying. Google sends Retry-After as whole seconds or
// as an HTTP date; anything it does not send falls back to exponential backoff with
// jitter, so several callers throttled together do not all come back at the same
// instant. `now` is injectable so the HTTP-date branch is testable.
export function backoffMs(res: Response, attempt: number, now: number = Date.now()): number {
  const header = res.headers.get('Retry-After')
  if (header) {
    const seconds = Number(header.trim())
    // Number('') is 0, and an empty header means nothing, so require a real value.
    const ms = header.trim() !== '' && Number.isFinite(seconds) ? seconds * 1000 : new Date(header).getTime() - now
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_BACKOFF_MS)
  }
  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 250), MAX_BACKOFF_MS)
}
