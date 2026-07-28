import { describe, it, expect } from 'vitest'
import {
  TokenBucket, shouldBackOff, backoffMs, MAX_BACKOFF_MS,
} from '@/modules/google-sheet-products-for-shop/lib/rate-limit'

// A bucket sized so a full minute's worth of tokens is spent in milliseconds:
// 6000/minute refills one token every 10ms, which keeps these tests quick while
// exercising exactly the arithmetic the real 60/minute bucket uses.
const PER_MINUTE = 6_000
const REFILL_MS = 60_000 / PER_MINUTE

function withHeaders(headers: Record<string, string>): Response {
  return new Response(null, { status: 429, headers })
}

describe('TokenBucket', () => {
  it('lets a full bucket through without waiting', async () => {
    const bucket = new TokenBucket(PER_MINUTE)
    const started = Date.now()
    for (let i = 0; i < 50; i++) await bucket.take()
    expect(Date.now() - started).toBeLessThan(REFILL_MS * 10)
  })

  it('paces callers once the bucket is empty', async () => {
    const bucket = new TokenBucket(10)
    for (let i = 0; i < 10; i++) await bucket.take()
    // Bucket now empty and refilling at 10/minute, i.e. one every 6 seconds - far
    // longer than this test should wait, so just prove the next take is pending.
    let released = false
    void bucket.take().then(() => { released = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(released).toBe(false)
  })

  it('serialises concurrent callers rather than letting them all read the same count', async () => {
    // Burst of 10 against a 10ms refill. Twenty callers ask at once: if they shared
    // a stale token count they would all see room and all go immediately, which is
    // the stampede that causes the 429 in the first place. Queued, the back ten wait
    // for one refill each.
    const bucket = new TokenBucket(PER_MINUTE, 10)
    const started = Date.now()
    await Promise.all(Array.from({ length: 20 }, () => bucket.take()))
    const elapsed = Date.now() - started
    // Ten refills at 10ms, with a little slack for timer coarseness either way.
    expect(elapsed).toBeGreaterThanOrEqual(REFILL_MS * 10 * 0.8)
    expect(elapsed).toBeLessThan(REFILL_MS * 10 * 5)
  })
})

describe('shouldBackOff', () => {
  it('retries 429 on reads and writes alike - the request was refused, not run', () => {
    expect(shouldBackOff(429, true)).toBe(true)
    expect(shouldBackOff(429, false)).toBe(true)
  })

  it('retries 5xx on reads only, so a half-applied write is never repeated', () => {
    expect(shouldBackOff(500, true)).toBe(true)
    expect(shouldBackOff(503, true)).toBe(true)
    expect(shouldBackOff(500, false)).toBe(false)
  })

  it('never retries a plain refusal', () => {
    expect(shouldBackOff(400, true)).toBe(false)
    expect(shouldBackOff(403, true)).toBe(false)
    expect(shouldBackOff(404, false)).toBe(false)
  })
})

describe('backoffMs', () => {
  it('honours Retry-After given in seconds', () => {
    expect(backoffMs(withHeaders({ 'Retry-After': '5' }), 0)).toBe(5_000)
  })

  it('honours Retry-After given as an HTTP date', () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0)
    const header = new Date(now + 4_000).toUTCString()
    expect(backoffMs(withHeaders({ 'Retry-After': header }), 0, now)).toBe(4_000)
  })

  it('caps a long Retry-After rather than sitting until the platform kills the run', () => {
    expect(backoffMs(withHeaders({ 'Retry-After': '600' }), 0)).toBe(MAX_BACKOFF_MS)
  })

  it('ignores a Retry-After already in the past', () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0)
    const header = new Date(now - 30_000).toUTCString()
    const ms = backoffMs(withHeaders({ 'Retry-After': header }), 0, now)
    expect(ms).toBeGreaterThanOrEqual(1_000)
    expect(ms).toBeLessThan(1_500)
  })

  it('falls back to exponential backoff with jitter when Google says nothing', () => {
    for (const [attempt, floor] of [[0, 1_000], [1, 2_000], [2, 4_000]] as const) {
      const ms = backoffMs(withHeaders({}), attempt)
      expect(ms).toBeGreaterThanOrEqual(floor)
      expect(ms).toBeLessThan(floor + 250)
    }
  })

  it('caps the exponential fallback too', () => {
    expect(backoffMs(withHeaders({}), 20)).toBe(MAX_BACKOFF_MS)
  })
})
