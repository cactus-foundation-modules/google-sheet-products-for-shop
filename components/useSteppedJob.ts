'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// The browser half of a stepped job.
//
// Push, Pull and the sheet check are all the same shape: POST a step, read the
// snapshot it returns, POST the next one, and poll a status endpoint alongside so
// the numbers keep moving while a long step is in flight. That loop - with its
// retry budget, its stop flag, its "did we make progress" reset and its polling
// interval - had been written out three times, and the three copies had already
// started to drift. It lives here once.
//
// Nothing in here knows what a Push or a Pull is. It is given a base path and the
// name of the job's id field, and it drives whatever is on the other end.

export type SteppedStatus = {
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  done: boolean
  error: string | null
  // Set by a job that knows its failure will never clear - a renamed tab, a
  // header with columns missing. Retrying it five times only makes the owner wait
  // longer to read what to do, so the loop stops at the first one.
  fatal?: boolean
}

// A failed response carries { error } whenever the route itself answered. It does
// not when the platform answers over the route's head - a 504 at the sixty-second
// ceiling, or a crash before any handler ran - and the fallback text alone then
// reads as a verdict on the sheet, which is exactly what it is not. Say which of
// the two happened.
export function failureText(res: Response, body: { error?: unknown }, fallback: string): string {
  if (typeof body.error === 'string' && body.error) return body.error
  if (res.status === 504) return `${fallback} It ran out of time (sixty seconds) before your site answered.`
  return `${fallback} Your site answered with an error (HTTP ${res.status}) rather than a reason.`
}

// How many times a step may fail in a row before we stop and offer Continue. A
// failure that follows real progress resets the count, so a long run with the odd
// hiccup keeps going; only a genuinely stuck one ever surfaces.
const MAX_STEP_RETRIES = 5
const POLL_MS = 1500
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

export type SteppedJob<S extends SteppedStatus> = {
  status: S | null
  setStatus: (next: S | null) => void
  /** True while the browser is driving steps (including an automatic retry). */
  working: boolean
  /** Set when the retry budget ran out, or a start call failed outright. */
  error: string | null
  setError: (message: string | null) => void
  /** Milliseconds since the loop first started, for the "this is taking a while" line. */
  elapsedMs: number
  /** Drive the job to completion, retrying transient failures. */
  run: (jobId: string) => Promise<void>
  /** Stop asking for steps and tell the server to abandon the job. */
  abandon: (jobId: string | null) => Promise<S | null>
  /** After an abandon, let a Continue press start the loop again. */
  allowRestart: () => void
}

export function useSteppedJob<S extends SteppedStatus>(cfg: {
  /** Base path of the job's routes, e.g. "/api/m/…/admin/pull". */
  endpoint: string
  /** The job's id field name, e.g. "pullJobId". */
  idKey: string
  /** What counts as forward movement, so a retry after real progress starts over. */
  progressOf: (status: S) => string
  /** Wording for the "it kept failing" message, e.g. "The pull". */
  noun: string
  initial?: S | null
}): SteppedJob<S> {
  const { endpoint, idKey, progressOf, noun } = cfg
  const [status, setStatus] = useState<S | null>(cfg.initial ?? null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  const pollRef = useRef<number | null>(null)
  const tickRef = useRef<number | null>(null)
  const looping = useRef(false)
  // Set the moment Stop is pressed. The step loop checks it before starting
  // another step, so the browser stops asking for work even while the request
  // already in flight is still finishing on the server.
  const stopRequested = useRef(false)
  const startedAt = useRef<number | null>(null)

  const stopTimers = useCallback(() => {
    if (pollRef.current != null) { window.clearInterval(pollRef.current); pollRef.current = null }
    if (tickRef.current != null) { window.clearInterval(tickRef.current); tickRef.current = null }
  }, [])

  useEffect(() => () => stopTimers(), [stopTimers])

  const run = useCallback(async (jobId: string) => {
    if (looping.current) return
    looping.current = true
    stopRequested.current = false
    setWorking(true)
    setError(null)
    // Timed from the start of THIS stretch of work, not from the first one ever.
    // A job paused and picked up again tomorrow would otherwise open its dialog
    // reading "19h 42m", which is true of the job and useless about the work.
    startedAt.current = Date.now()
    setElapsedMs(0)

    stopTimers()
    // Poll alongside the step loop: a single step can run for half a minute, and
    // without this the bars would only move when it returned.
    pollRef.current = window.setInterval(async () => {
      const r = await fetch(`${endpoint}/status?${idKey}=${encodeURIComponent(jobId)}`)
        .then((x) => (x.ok ? x.json() : null)).catch(() => null)
      if (r?.status) setStatus((prev) => (prev?.done ? prev : (r.status as S)))
    }, POLL_MS)
    tickRef.current = window.setInterval(() => {
      if (startedAt.current !== null) setElapsedMs(Date.now() - startedAt.current)
    }, 1000)

    let retries = 0
    let lastProgress: string | null = null
    // How many successful steps in a row have moved nothing. A step can honestly
    // do no work: another tab holds the job's lease, or the last request was
    // killed by the platform and its lease has not expired yet. The loop would
    // otherwise re-POST the instant each one returned - a round trip every
    // hundred milliseconds, for as long as the lease lasts. Backing off turns
    // that into a poll.
    let idleRuns = 0
    try {
      for (;;) {
        if (stopRequested.current) break
        let failReason: string | null = null
        try {
          const r = await fetch(`${endpoint}/step`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [idKey]: jobId }),
          })
          const j = await r.json().catch(() => null)
          if (r.ok && j?.status) {
            const next = j.status as S
            setStatus(next)
            if (next.done || next.status === 'CANCELLED') break
            const progress = progressOf(next)
            if (progress !== lastProgress) { lastProgress = progress; retries = 0; idleRuns = 0 }
            else idleRuns += 1
            if (next.status !== 'FAILED') {
              // Nothing moved: wait a moment rather than asking again at once.
              if (idleRuns > 0) await sleep(Math.min(400 * 2 ** (idleRuns - 1), 4000))
              continue
            }
            if (next.fatal) { setError(next.error); break }
            // A FAILED job keeps its cursor; stepping it again retries the same
            // slice, so transient causes (a database blip, a killed request)
            // heal themselves without the owner doing anything.
            failReason = next.error ?? `${noun} hit a snag.`
          } else {
            failReason = failureText(r, j ?? {}, `${noun} could not continue.`)
          }
        } catch {
          failReason = 'The connection dropped.' // network hiccup - retry quietly
        }
        retries += 1
        if (retries > MAX_STEP_RETRIES) {
          setError(`${failReason} It was retried ${MAX_STEP_RETRIES} times without getting further - press Continue to keep trying, or Cancel.`)
          break
        }
        await sleep(Math.min(2000 * retries, 8000))
      }
    } finally {
      looping.current = false
      setWorking(false)
      stopTimers()
    }
  }, [endpoint, idKey, progressOf, noun, stopTimers])

  const abandon = useCallback(async (jobId: string | null): Promise<S | null> => {
    stopRequested.current = true
    stopTimers()
    if (!jobId) return null
    const body = await fetch(`${endpoint}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [idKey]: jobId }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    return (body?.status as S | undefined) ?? null
  }, [endpoint, idKey, stopTimers])

  const allowRestart = useCallback(() => { stopRequested.current = false }, [])

  return { status, setStatus, working, error, setError, elapsedMs, run, abandon, allowRestart }
}
