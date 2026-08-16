'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PullStatus, PushStatus, PreviewStatus, PullPreview, SyncRowError,
} from '@/modules/google-sheet-products-for-shop/lib/types'
import { useSteppedJob, failureText } from '@/modules/google-sheet-products-for-shop/components/useSteppedJob'

// The Google Sheet controls, injected onto shop's Products page through the
// `shop.products-toolbar` extension point. A single dropdown (Open / Push / Pull /
// Logs) that only appears once a sheet is connected, plus the dialogs the Push,
// the Pull and the sync log open into. Setup itself stays on Settings > Google
// Sheet.
//
// All three dialogs are the same underneath: a job the browser drives one step at
// a time, watching a snapshot come back (see useSteppedJob). What differs is only
// what the numbers mean and what the words say.

const BASE = '/api/m/google-sheet-products-for-shop/admin'
const muted = { color: 'var(--color-text-muted)' }
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : 'never')

type Settings = { hasOAuthConnected: boolean; spreadsheetId: string | null; spreadsheetUrl: string | null; lastPushAt: string | null; lastPullAt: string | null }

type SyncLog = {
  id: string
  direction: 'PUSH' | 'PULL'
  tab: 'PRODUCTS' | 'VARIATIONS'
  status: 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED'
  createdCount: number
  updatedCount: number
  skippedCount: number
  archivedCount: number
  errors: SyncRowError[] | null
  createdAt: string
}

// Pluralise without the "(s)" crutch - "1 product" / "3 products" reads like a
// person wrote it.
function n(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`
}

// "42s", "3m 07s". Shown while something is running so a long job reads as
// working rather than stuck - the single most common reason an owner reaches for
// the close button on a job that was going to finish.
function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

// --- shared dialog furniture ------------------------------------------------

function Modal({ title, onClose, children, footer, width = 660 }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  // Escape closes, like every other dialog in the admin. It goes through the same
  // close handler as the ✕, so a running job still asks before it stops.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 1000 }}
    >
      <div
        className="card"
        style={{ width: '100%', maxWidth: width, maxHeight: '85vh', display: 'flex', flexDirection: 'column', cursor: 'auto', padding: 0 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '1rem 1.25rem', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '1.25rem', overflowY: 'auto' }}>{children}</div>
        {/* The buttons stay put while the body scrolls: on a long list of changes
            they used to sit below the fold, and "where is the Pull button" is not
            a question a confirm dialog should raise. */}
        {footer && (
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.85rem 1.25rem', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)', borderBottomLeftRadius: 'inherit', borderBottomRightRadius: 'inherit' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

function bar(done: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.min(100, Math.round((done / total) * 100))}%`
}

function ProgressRow({ label, done, total, hint }: { label: string; done: number; total: number; hint?: string }) {
  return (
    <div style={{ marginBottom: '0.6rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.8125rem', marginBottom: '0.2rem' }}>
        <span>{label}</span>
        <span style={muted}>{hint ?? `${done} of ${total}`}</span>
      </div>
      <div style={{ height: '0.5rem', background: 'var(--color-bg-subtle)', borderRadius: '999px', overflow: 'hidden' }}>
        <div style={{ width: bar(done, total), height: '100%', background: 'var(--color-primary)', transition: 'width 0.3s ease' }} />
      </div>
    </div>
  )
}

// The step tracker: which stage we are on, and that there are more to come. One
// bar on its own tells an owner nothing about whether that bar IS the job.
function PhasePills({ steps, current }: { steps: Array<{ key: string; label: string }>; current: string }) {
  const currentIdx = steps.findIndex((s) => s.key === current)
  const at = currentIdx < 0 ? steps.length : currentIdx // an unknown/final phase reads as "all done"
  return (
    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.85rem', fontSize: '0.75rem', flexWrap: 'wrap' }}>
      {steps.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'active' : 'pending'
        return (
          <div key={s.key} style={{
            padding: '0.15rem 0.55rem', borderRadius: '999px',
            background: state === 'pending' ? 'var(--color-bg-subtle)' : 'var(--color-primary)',
            color: state === 'pending' ? 'var(--color-text-muted)' : 'var(--color-on-primary)',
            opacity: state === 'done' ? 0.6 : 1, fontWeight: state === 'active' ? 600 : 400,
          }}>
            {state === 'done' ? '✓ ' : ''}{s.label}
          </div>
        )
      })}
    </div>
  )
}

// The last few rows that went through, newest first. A fixed height so the
// dialog does not jump about as names come and go, and each line clipped rather
// than wrapped - a long product name must not reflow the box every 200ms.
function RecentItems({ items }: { items: string[] }) {
  return (
    <div style={{ marginTop: '0.5rem', marginBottom: '0.25rem' }}>
      <div style={{ ...muted, fontSize: '0.75rem', marginBottom: '0.25rem' }}>Just done</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '7.5rem', overflowY: 'auto' }}>
        {items.map((item, i) => (
          <li key={`${item}-${i}`} style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.6 }}>
            ✓ {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

// The headline of a running job: what it is doing, and for how long. Announced to
// screen readers as it changes, which the old silent bars never were.
function RunningLine({ text, ms, tone = 'normal' }: { text: string; ms: number; tone?: 'normal' | 'danger' }) {
  return (
    <p
      aria-live="polite"
      style={{
        fontWeight: 600, marginBottom: '0.75rem', display: 'flex', gap: '0.6rem',
        alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap',
        color: tone === 'danger' ? 'var(--color-danger)' : undefined,
      }}
    >
      <span>{text}</span>
      {ms > 0 && <span style={{ ...muted, fontWeight: 400, fontSize: '0.8125rem' }}>{elapsed(ms)}</span>}
    </p>
  )
}

// One headline figure on the confirm screen. Reads at a glance in a way a
// sentence of counts never did.
function Tally({ value, label, tone }: { value: number; label: string; tone?: 'danger' | 'warning' }) {
  const colour = tone === 'danger' ? 'var(--color-danger)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-text)'
  return (
    <div style={{ flex: '1 1 6rem', minWidth: '5.5rem', padding: '0.6rem 0.7rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)' }}>
      <div style={{ fontSize: '1.25rem', fontWeight: 700, lineHeight: 1.1, color: colour }}>{value}</div>
      <div style={{ ...muted, fontSize: '0.75rem' }}>{label}</div>
    </div>
  )
}

// --- the toolbar ------------------------------------------------------------

export function GoogleSheetProductsToolbar() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modal, setModal] = useState<null | 'push' | 'pull' | 'logs'>(null)
  // An unfinished Pull found on load (or left after a failure) - offer Continue.
  const [resumable, setResumable] = useState<PullStatus | null>(null)
  // The same for a Push, which is a resumable job too.
  const [resumablePush, setResumablePush] = useState<PushStatus | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const loadSettings = useCallback(async () => {
    const s = await fetch(`${BASE}/settings`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (s) {
      setSettings({
        hasOAuthConnected: !!s.hasOAuthConnected,
        spreadsheetId: s.spreadsheetId ?? null,
        spreadsheetUrl: s.spreadsheetUrl ?? null,
        lastPushAt: s.lastPushAt ?? null,
        lastPullAt: s.lastPullAt ?? null,
      })
    }
  }, [])

  const checkResumable = useCallback(async () => {
    const [r, p] = await Promise.all([
      fetch(`${BASE}/pull/status`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
      fetch(`${BASE}/push/status`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
    ])
    setResumable(r?.status && !r.status.done ? r.status : null)
    setResumablePush(p?.status && !p.status.done ? p.status : null)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await loadSettings()
      if (!cancelled) await checkResumable()
    })()
    return () => { cancelled = true }
  }, [loadSettings, checkResumable])

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Only render once a sheet is actually connected; setup lives in Settings.
  if (!settings || !settings.hasOAuthConnected || !settings.spreadsheetId) return null

  const open = (which: 'push' | 'pull' | 'logs') => { setMenuOpen(false); setModal(which) }
  const closeModal = () => { setModal(null); void loadSettings(); void checkResumable() }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        Google Sheet <span aria-hidden style={{ fontSize: '0.7em' }}>▾</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="card"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 0.25rem)', zIndex: 50,
            minWidth: '15rem', padding: '0.35rem', display: 'grid', gap: '0.1rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          {resumablePush && (
            <button type="button" className="gsp-menu-item" style={{ color: 'var(--color-primary)', fontWeight: 600 }} onClick={() => open('push')} role="menuitem">
              Resume push…
            </button>
          )}
          {resumable && (
            <button type="button" className="gsp-menu-item" style={{ color: 'var(--color-primary)', fontWeight: 600 }} onClick={() => open('pull')} role="menuitem">
              Resume pull…
            </button>
          )}
          {settings.spreadsheetUrl && (
            <a className="gsp-menu-item" href={settings.spreadsheetUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setMenuOpen(false)}>
              Open sheet ↗
            </a>
          )}
          <button type="button" className="gsp-menu-item" onClick={() => open('push')} role="menuitem">Push to sheet…</button>
          <button type="button" className="gsp-menu-item" onClick={() => open('pull')} role="menuitem">Pull from sheet…</button>
          <button type="button" className="gsp-menu-item" onClick={() => open('logs')} role="menuitem">Sheet logs</button>
          {/* Which way round the sheet and the site last were, without opening
              anything. The commonest question the menu was asked. */}
          <div style={{ ...muted, fontSize: '0.7rem', padding: '0.35rem 0.6rem 0.15rem', borderTop: '1px solid var(--color-border)', marginTop: '0.2rem' }}>
            Last push {fmt(settings.lastPushAt)}<br />Last pull {fmt(settings.lastPullAt)}
          </div>
        </div>
      )}

      {modal === 'push' && <PushModal resumable={resumablePush} onClose={closeModal} onResumableChange={setResumablePush} />}
      {modal === 'pull' && <PullModal resumable={resumable} onClose={closeModal} onResumableChange={setResumable} />}
      {modal === 'logs' && <LogsModal onClose={() => setModal(null)} />}

      <style dangerouslySetInnerHTML={{ __html: `
        .gsp-menu-item {
          display: block; width: 100%; text-align: left; background: none; border: none;
          padding: 0.45rem 0.6rem; border-radius: var(--radius-sm); font: inherit; color: var(--color-text);
          cursor: pointer; text-decoration: none;
        }
        .gsp-menu-item:hover { background: var(--color-bg-subtle); }
      ` }} />
    </div>
  )
}

// --- Pull: check -> confirm -> apply ----------------------------------------

const PULL_STEPS = [
  { key: 'PRODUCTS', label: 'Products' },
  { key: 'DELETIONS', label: 'Removals' },
  { key: 'VARIATIONS', label: 'Variations' },
]
const PULL_PHASE_LABEL: Record<PullStatus['phase'], string> = {
  PRODUCTS: 'Updating products…',
  DELETIONS: 'Removing items no longer in the sheet…',
  VARIATIONS: 'Updating variations…',
  DONE: 'Done',
}

const CHECK_STEPS = [
  { key: 'READ', label: 'Reading sheet' },
  { key: 'PRODUCTS', label: 'Products' },
  { key: 'DELETIONS', label: 'Removals' },
  { key: 'VARIATIONS', label: 'Variations' },
]
const CHECK_PHASE_LABEL: Record<PreviewStatus['phase'], string> = {
  READ: 'Reading your sheet…',
  PRODUCTS: 'Comparing your products…',
  DELETIONS: 'Working out what has gone…',
  VARIATIONS: 'Comparing your variations…',
  DONE: 'Finishing off…',
}

function PullModal({ resumable, onClose, onResumableChange }: {
  resumable: PullStatus | null
  onClose: () => void
  onResumableChange: (s: PullStatus | null) => void
}) {
  // The check that works out what a Pull would do. Skipped entirely when we open
  // straight onto a job already part-way through.
  const check = useSteppedJob<PreviewStatus>({
    endpoint: `${BASE}/pull/preview`,
    idKey: 'previewJobId',
    noun: 'The check',
    progressOf: (s) => `${s.phase}:${s.tabsDone}:${s.productsDone}:${s.variationsDone}`,
  })
  const pull = useSteppedJob<PullStatus>({
    endpoint: `${BASE}/pull`,
    idKey: 'pullJobId',
    noun: 'The pull',
    // Every cursor that can move, removals included. Leave one out and a stage
    // that only moves THAT one reads as making no progress: the retry budget
    // stops resetting, and the idle backoff paces the stage at four seconds a
    // step for no reason. Removals only grew a cursor of its own recently, which
    // is exactly how it would have been missed.
    progressOf: (s) => `${s.phase}:${s.productsDone}:${s.deletionsDone}:${s.variationsDone}`,
    initial: resumable,
  })

  // Derived, not stored: the finished check IS the preview, so a fresh check
  // (which clears the status) puts the dialog back on the progress view by
  // itself, with nothing to keep in step.
  const preview: PullPreview | null = check.status?.done ? check.status.preview : null
  const [previewJobId, setPreviewJobId] = useState<string | null>(null)
  const [startErr, setStartErr] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [checkStarting, setCheckStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const pullJobId = useRef<string | null>(resumable?.pullJobId ?? null)

  // Kick off (or rejoin) a check of the sheet.
  const startingCheck = useRef(false)
  // `fresh` is the owner explicitly choosing to throw away a part-finished check
  // and start at the first tab again. The default is always to carry on: a check
  // that got most of the way through a big catalogue and then stopped must not
  // lose that work to the button offered to continue it.
  const runCheck = useCallback(async (opts?: { fresh?: boolean }) => {
    if (startingCheck.current) return
    startingCheck.current = true
    setCheckStarting(true)
    setStartErr(null)
    check.setStatus(null)
    check.setError(null)
    check.allowRestart()
    try {
      const res = await fetch(`${BASE}/pull/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fresh: opts?.fresh === true }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.previewJobId) { setStartErr(failureText(res, body, 'Could not check your sheet.')); return }
      setPreviewJobId(body.previewJobId)
      if (body.status) check.setStatus(body.status)
      setCheckStarting(false)
      await check.run(body.previewJobId)
    } catch {
      setStartErr('Could not reach your site to check the sheet.')
    } finally {
      setCheckStarting(false)
      startingCheck.current = false
    }
  }, [check])

  // Start the check on open, unless we opened straight into a resumable Pull.
  // Yield a microtask first so the opening setState never runs synchronously
  // inside the effect (react-hooks/set-state-in-effect).
  const began = useRef(false)
  useEffect(() => {
    if (began.current) return
    began.current = true
    if (resumable) void pull.run(resumable.pullJobId)
    else void (async () => { await Promise.resolve(); await runCheck() })()
  }, [resumable, pull, runCheck])

  // Keep the parent's Continue prompt in step with where the Pull ends up.
  useEffect(() => {
    const s = pull.status
    if (!s) return
    onResumableChange(s.done ? null : (s.status === 'FAILED' || s.status === 'RUNNING') ? s : null)
  }, [pull.status, onResumableChange])

  async function startPull() {
    setStarting(true)
    setStartErr(null)
    // The check's id goes with it: the server adopts what that check already
    // worked out rather than reading and comparing the whole sheet a second time.
    // If it has gone stale (the sheet moved, or it is old) the server quietly
    // falls back to doing the work itself.
    const res = await fetch(`${BASE}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewJobId }),
    })
    const body = await res.json().catch(() => ({}))
    setStarting(false)
    if (res.status === 409 && body.pullJobId) { pullJobId.current = body.pullJobId; await pull.run(body.pullJobId); return }
    // The sheet moved while the owner was reading the list, so the list is not
    // what a Pull would do any more. Check again and show them the new answer -
    // pulling the old one would apply a plan that no longer matches the sheet.
    if (res.status === 409 && body.stalePreview) {
      setStartErr(typeof body.error === 'string' ? body.error : 'Your sheet has changed - checking it again.')
      await runCheck()
      return
    }
    if (!res.ok || !body.pullJobId) { setStartErr(failureText(res, body, 'Pull failed to start.')); return }
    pullJobId.current = body.pullJobId
    pull.setStatus({
      pullJobId: body.pullJobId, status: 'RUNNING', phase: 'PRODUCTS', done: false,
      productsTotal: body.productsTotal ?? 0, productsDone: 0,
      variationsTotal: body.variationsTotal ?? 0, variationsDone: 0,
      deletionsTotal: (body.detected?.productsDelete ?? 0) + (body.detected?.variationsDelete ?? 0), deletionsDone: 0,
      currentItem: null, recentItems: [],
      detected: body.detected ?? null,
      counts: { productsCreated: 0, productsUpdated: 0, productsDeleted: 0, variationsCreated: 0, variationsUpdated: 0, variationsDeleted: 0 },
      errorCount: 0, error: null,
    })
    await pull.run(body.pullJobId)
  }

  async function continuePull() {
    const jobId = pullJobId.current ?? pull.status?.pullJobId
    pull.allowRestart()
    if (jobId) await pull.run(jobId)
  }

  const abandonPull = useCallback(async (): Promise<PullStatus | null> => {
    const jobId = pullJobId.current ?? pull.status?.pullJobId
    const snapshot = await pull.abandon(jobId ?? null)
    onResumableChange(null)
    return snapshot
  }, [pull, onResumableChange])

  const STOP_PULL_CONFIRM = 'Stop this pull?\n\nEverything already updated stays as it is - the rest of your sheet just will not be applied. You can pull again whenever you like.'

  // Closing the dialog while a job is unfinished STOPS that job, after the same
  // confirm as Stop. It used to just unmount the dialog and leave the job to be
  // resumed later - which read as "it carried on after I closed it". Closing the
  // whole browser tab still pauses rather than stops (nothing client-side runs to
  // cancel it), which is what the resumable design is for.
  //
  // A check is different: it writes nothing, so closing simply abandons it, with
  // nothing to warn about.
  function requestClose() {
    const s = pull.status
    const unfinished = s && !s.done && s.status !== 'CANCELLED'
    if (unfinished) {
      if (!confirm(STOP_PULL_CONFIRM)) return
      void (async () => { await abandonPull(); onClose() })()
      return
    }
    if (check.status && !check.status.done && check.status.status !== 'CANCELLED') {
      void check.abandon(previewJobId)
    }
    onClose()
  }

  async function stopPull() {
    if (!confirm(STOP_PULL_CONFIRM)) return
    setStopping(true)
    const snapshot = await abandonPull()
    setStopping(false)
    pull.setStatus(snapshot ?? (pull.status ? { ...pull.status, status: 'CANCELLED' } : null))
  }

  // ---- applying (a Pull job exists) ----
  if (pull.status) {
    return <PullProgress
      status={pull.status}
      working={pull.working}
      elapsedMs={pull.elapsedMs}
      error={pull.error}
      stopping={stopping}
      onStop={stopPull}
      onContinue={continuePull}
      onCancel={async () => { await abandonPull(); onClose() }}
      onClose={onClose}
      requestClose={requestClose}
    />
  }

  // ---- checking ----
  if (!preview) {
    const s = check.status
    const failed = s?.status === 'FAILED'
    const cancelled = s?.status === 'CANCELLED'
    const busy = check.working || checkStarting
    // Did it get anywhere before it stopped? If so, the work is still on the job
    // and carrying on is a real option rather than a polite fiction.
    const hasProgress = !!s && !busy && (s.productsDone > 0 || s.variationsDone > 0 || s.tabsDone > 0)
    return (
      <Modal
        title="Pull from sheet"
        onClose={requestClose}
        footer={
          <>
            {busy ? (
              <>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { void check.abandon(previewJobId); onClose() }}>Stop</button>
                <span style={muted}>Nothing is being changed yet - this is only a look.</span>
              </>
            ) : hasProgress ? (
              // It got somewhere before it stopped. Carrying on is the obvious
              // thing and so it leads; starting over is offered too, because
              // sometimes that IS what you want - but it says what it costs.
              <>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void runCheck()}>
                  Carry on from {s!.productsDone > 0 ? n(s!.productsDone, 'product') : n(s!.tabsDone, 'tab')}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runCheck({ fresh: true })}>
                  Start again
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={requestClose}>Close</button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void runCheck()}>
                  {failed || startErr ? 'Try again' : 'Check again'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={requestClose}>Close</button>
              </>
            )}
          </>
        }
      >
        {startErr ? (
          <p style={{ color: 'var(--color-danger)' }}>{startErr}</p>
        ) : (
          <>
            <RunningLine
              text={
                failed && hasProgress ? 'The check stopped part-way - nothing is lost.'
                : failed ? 'The check stopped.'
                : cancelled ? 'Check stopped.'
                : CHECK_PHASE_LABEL[s?.phase ?? 'READ']
              }
              ms={check.elapsedMs}
              tone={failed && !hasProgress ? 'danger' : 'normal'}
            />
            {!failed && !cancelled && <PhasePills steps={CHECK_STEPS} current={s?.phase ?? 'READ'} />}

            {/* The removals stage has no per-row cursor to draw a bar from - it is
                a handful of bulk queries - so it gets a named line instead. It ran
                for minutes on a real catalogue showing nothing at all, which is
                the complaint this whole rework exists to answer, surviving into
                the one phase that had not been given anything to say. */}
            {s?.phase === 'DELETIONS' && (
              <p style={{ ...muted, fontSize: '0.8125rem', marginBottom: '0.6rem' }}>
                {s.currentItem ? `${s.currentItem}…` : 'Working out what has gone…'}
              </p>
            )}

            {s && s.tabsTotal > 0 && <ProgressRow label="Product tabs read" done={s.tabsDone} total={s.tabsTotal} />}
            {s && s.productsTotal > 0 && <ProgressRow label="Products compared" done={s.productsDone} total={s.productsTotal} />}
            {s && s.variationsTotal > 0 && <ProgressRow label="Variations compared" done={s.variationsDone} total={s.variationsTotal} hint={`${s.variationsDone} of ${n(s.variationsTotal, 'product')}`} />}

            {s?.currentItem && (
              <p style={{ ...muted, fontSize: '0.8125rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.currentItem}
              </p>
            )}

            {(failed || check.error) && (
              <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
                {check.error ?? s?.error}
              </p>
            )}

            {!s && !failed && (
              <p style={{ ...muted, fontSize: '0.8125rem' }}>
                Reading a big sheet takes a moment. You can leave this open - it keeps going while you watch.
              </p>
            )}

            {/* Retries are meant to be invisible, and mostly should be - but a run
                that covered for eight failed requests looked flawless here while
                showing up as 5xx in the site's monitoring, and only one of those
                two was being told. Said quietly, after the fact. */}
            {check.retries > 0 && (
              <p style={{ ...muted, fontSize: '0.75rem', marginTop: '0.4rem' }}>
                {n(check.retries, 'step')} had to be tried again along the way. That is normal on a big sheet and nothing was lost.
              </p>
            )}

            {s?.fatal && (
              <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.5rem' }}>
                Nothing has been changed. Put that right in your sheet, then check again.
              </p>
            )}
          </>
        )}
      </Modal>
    )
  }

  // ---- confirm ----
  return <PullConfirm
    preview={preview}
    starting={starting}
    error={startErr}
    onPull={startPull}
    onRecheck={() => void runCheck()}
    onClose={requestClose}
  />
}

// The confirm screen: what Pull is actually going to do, before it does it.
function PullConfirm({ preview, starting, error, onPull, onRecheck, onClose }: {
  preview: PullPreview
  starting: boolean
  error: string | null
  onPull: () => void
  onRecheck: () => void
  onClose: () => void
}) {
  const p = preview.products
  const v = preview.variations
  const deleteCount = p.toDeleteTotal + v.toDeleteTotal
  const errorCount = p.rowErrorsTotal + v.rowErrorsTotal
  const unchangedTotal = p.unchanged + v.unchanged
  const totalRows = p.toCreateTotal + p.toUpdateTotal + p.unchanged + v.toCreate + v.toUpdateTotal + v.unchanged
  const changedTotal = p.toCreateTotal + p.toUpdateTotal + v.toCreate + v.toUpdateTotal
  // Row errors are neither "changed" nor "unchanged" - a row the check rejected
  // (a product left without its required price) creates no work but is not a
  // clean match either. Left out of this test, a sheet whose only problem is an
  // error row read as "already matches your shop", hiding the error behind a
  // Close button.
  const nothingToDo = totalRows > 0 && changedTotal === 0 && deleteCount === 0 && errorCount === 0

  if (preview.headerMissing.length > 0) {
    return (
      <Modal
        title="Pull from sheet"
        onClose={onClose}
        footer={<>
          <button type="button" className="btn btn-primary btn-sm" onClick={onRecheck}>Check again</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </>}
      >
        <p style={{ color: 'var(--color-danger)', fontWeight: 600 }}>Your sheet is missing some columns.</p>
        <p style={{ marginBottom: '0.5rem' }}>
          Put these back in the header row of the Products tab, then check again: <strong>{preview.headerMissing.join(', ')}</strong>.
        </p>
        <p style={muted}>Nothing has been changed. A Pull will not run until the header is right.</p>
      </Modal>
    )
  }

  if (nothingToDo) {
    return (
      <Modal
        title="Pull from sheet"
        onClose={onClose}
        footer={<>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRecheck}>Check again</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button>
        </>}
      >
        <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Your sheet already matches your shop.</p>
        <p style={muted}>
          Checked {n(totalRows, 'row')} - nothing to create, update, or remove. If you have just edited the sheet,
          Check again re-reads it.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      title="Pull from sheet"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-primary btn-sm" onClick={onPull} disabled={starting}>
          {starting ? 'Starting…' : `Pull${deleteCount ? ` and delete ${deleteCount}` : ''}`}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRecheck} disabled={starting}>Check again</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={starting}>Cancel</button>
        {error && <span style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>{error}</span>}
      </>}
    >
      <p style={{ ...muted, marginBottom: '0.75rem' }}>
        Checked {n(totalRows, 'row')}{unchangedTotal > 0 ? ` - ${n(unchangedTotal, 'row')} already matched and will be left alone` : ''}.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <Tally value={p.toCreateTotal} label="products to add" />
        <Tally value={p.toUpdateTotal} label="products to update" />
        <Tally value={v.toCreate + v.toUpdateTotal} label="variations to change" />
        {deleteCount > 0 && <Tally value={deleteCount} label="to be deleted" tone="danger" />}
        {errorCount > 0 && <Tally value={errorCount} label="rows with errors" tone="warning" />}
      </div>

      {preview.staleness.changedSinceLastPush > 0 && (
        <p style={{ fontWeight: 600, marginBottom: '0.75rem' }}>
          {n(preview.staleness.changedSinceLastPush, 'product')} changed in the admin since you last pushed. Pulling will overwrite those changes.
        </p>
      )}

      {errorCount > 0 && (
        <details style={{ marginBottom: '0.75rem' }}>
          <summary style={{ cursor: 'pointer' }}>Rows with errors</summary>
          <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.5rem 0 0 1rem' }}>
            {p.rowErrors.map((e, i) => <li key={`p${i}`}>Products row {e.row}: {e.reason}</li>)}
            {v.rowErrors.map((e, i) => <li key={`v${i}`}>Variations row {e.row}: {e.reason}</li>)}
            {errorCount > p.rowErrors.length + v.rowErrors.length && (
              <li>…and {n(errorCount - p.rowErrors.length - v.rowErrors.length, 'more')}.</li>
            )}
          </ul>
        </details>
      )}

      {p.toUpdateTotal > 0 && (
        <details style={{ marginBottom: '0.75rem' }}>
          <summary style={{ cursor: 'pointer' }}>What&apos;s changing on {n(p.toUpdateTotal, 'product')}</summary>
          <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.5rem 0 0 1rem', maxHeight: '14rem', overflowY: 'auto' }}>
            {p.toUpdate.slice(0, 25).map((m, i) => (
              <li key={i}>
                {m.name}{m.sku ? ` (${m.sku})` : ''}: {m.changes.map((c) => `${c.field} "${c.from}" → "${c.to}"`).join(', ')}
              </li>
            ))}
            {p.toUpdateTotal > 25 && <li>…and {n(p.toUpdateTotal - 25, 'more')}.</li>}
          </ul>
        </details>
      )}

      {v.toUpdateTotal > 0 && (
        <details style={{ marginBottom: '0.75rem' }}>
          <summary style={{ cursor: 'pointer' }}>Which {n(v.toUpdateTotal, 'variation')} will be updated</summary>
          <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.5rem 0 0 1rem', maxHeight: '14rem', overflowY: 'auto' }}>
            {v.toUpdate.slice(0, 25).map((x, i) => <li key={i}>{x.parentName} - {x.label}</li>)}
            {v.toUpdateTotal > 25 && <li>…and {n(v.toUpdateTotal - 25, 'more')}.</li>}
          </ul>
        </details>
      )}

      {p.toDeleteTotal > 0 && (
        <div style={{ marginBottom: '0.75rem', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-danger)' }}>
          <div style={{ fontWeight: 600, color: 'var(--color-danger)' }}>In the shop but not in your sheet</div>
          <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>
            {n(p.toDeleteTotal, 'product')} will be permanently deleted on Pull, together with any of their variations. This cannot be undone.
          </p>
          <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.25rem 0 0 1rem', maxHeight: '12rem', overflowY: 'auto' }}>
            {p.toDelete.map((m) => <li key={m.id}>{m.name}{m.sku ? ` (${m.sku})` : ''}</li>)}
            {p.toDeleteTotal > p.toDelete.length && <li>…and {n(p.toDeleteTotal - p.toDelete.length, 'more')}.</li>}
          </ul>
        </div>
      )}

      {v.toDeleteTotal > 0 && (
        <div style={{ marginBottom: '0.75rem', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-danger)' }}>
          <div style={{ fontWeight: 600, color: 'var(--color-danger)' }}>Variations on your site but not in your sheet</div>
          <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>
            {n(v.toDeleteTotal, 'variation is', 'variations are')} on your site but no longer in the sheet. Pulling removes {v.toDeleteTotal === 1 ? 'it' : 'them'} for good.
          </p>
          <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.25rem 0 0 1rem', maxHeight: '12rem', overflowY: 'auto' }}>
            {v.toDelete.map((x) => <li key={x.childProductId}>{x.parentName} - {x.label}</li>)}
            {v.toDeleteTotal > v.toDelete.length && <li>…and {n(v.toDeleteTotal - v.toDelete.length, 'more')}.</li>}
          </ul>
        </div>
      )}
    </Modal>
  )
}

// The Pull itself, running.
function PullProgress({ status, working, elapsedMs, error, stopping, onStop, onContinue, onCancel, onClose, requestClose }: {
  status: PullStatus
  working: boolean
  elapsedMs: number
  error: string | null
  stopping: boolean
  onStop: () => void
  onContinue: () => void
  onCancel: () => void
  onClose: () => void
  requestClose: () => void
}) {
  const c = status.counts
  const failed = status.status === 'FAILED'
  const cancelled = status.status === 'CANCELLED'
  const unchanged = (status.detected?.productsUnchanged ?? 0) + (status.detected?.variationsUnchanged ?? 0)

  const headline = status.done ? 'Pull complete.'
    : cancelled && working ? 'Stopping - finishing the batch already under way…'
    : cancelled ? 'Pull stopped. Everything below already went through and stays as it is; the rest of the sheet was left alone.'
    : failed && working ? 'Hit a snag - retrying automatically…'
    : failed ? `The pull stopped: ${status.error ?? 'unknown error'}. Nothing is lost - press Continue to pick up where it left off.`
    // The named row, with the verb the stage is actually doing. "Updating
    // <product>…" while that product is being deleted is the wrong word at the
    // worst possible moment.
    : status.currentItem ? `${status.phase === 'DELETIONS' ? 'Removing' : 'Updating'} ${status.currentItem}…`
    : PULL_PHASE_LABEL[status.phase]

  return (
    <Modal
      title={cancelled ? 'Pull stopped' : status.done ? 'Pull complete' : 'Pulling from your sheet'}
      onClose={requestClose}
      footer={
        status.done || (cancelled && !working) ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button>
        ) : cancelled ? (
          <span style={muted}>Stopping… this dialog will settle in a moment.</span>
        ) : working ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStop} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop pull'}
            </button>
            <span style={muted}>
              {failed ? 'Retrying… stop it if you would rather not wait.' : 'Working… leave this open until it finishes. Closing this window stops the pull.'}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onContinue}>Continue</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel pull</button>
          </>
        )
      }
    >
      <RunningLine text={headline} ms={status.done || cancelled ? 0 : elapsedMs} tone={failed && !working ? 'danger' : 'normal'} />

      {!status.done && !cancelled && <PhasePills steps={PULL_STEPS} current={status.phase} />}

      <ProgressRow label="Products" done={status.productsDone} total={status.productsTotal} />
      {status.deletionsTotal > 0 && (
        <ProgressRow label="Removals" done={status.deletionsDone} total={status.deletionsTotal} />
      )}
      <ProgressRow label="Variations" done={status.variationsDone} total={status.variationsTotal} />

      {!status.done && status.recentItems.length > 0 && <RecentItems items={status.recentItems} />}

      {unchanged > 0 && (
        <p style={{ ...muted, fontSize: '0.75rem', marginTop: '-0.35rem', marginBottom: '0.6rem' }}>
          Only rows that actually changed are being touched - {n(unchanged, 'row')} already matched your sheet and {unchanged === 1 ? 'was' : 'were'} skipped.
        </p>
      )}

      <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.75rem' }}>
        {n(c.productsCreated, 'product')} added, {n(c.productsUpdated, 'product')} updated{c.productsDeleted ? `, ${n(c.productsDeleted, 'product')} deleted` : ''}.
        {' '}{n(c.variationsCreated, 'variation')} added, {n(c.variationsUpdated, 'variation')} updated{c.variationsDeleted ? `, ${n(c.variationsDeleted, 'variation')} removed` : ''}.
        {status.errorCount ? ` ${n(status.errorCount, 'row')} had errors.` : ''}
      </p>

      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>{error}</p>}
    </Modal>
  )
}

// --- Push --------------------------------------------------------------------

const PUSH_STEPS = [
  { key: 'BUILD_PRODUCTS', label: 'Reading catalogue' },
  { key: 'BUILD_TABS', label: 'Reading variations' },
  { key: 'PRODUCTS', label: 'Products' },
  { key: 'VARIATION_TABS', label: 'Product tabs' },
  { key: 'CLEANUP', label: 'Tidy up' },
]
const PUSH_PHASE_LABEL: Record<PushStatus['phase'], string> = {
  BUILD_PRODUCTS: 'Reading your catalogue…',
  BUILD_TABS: 'Reading your variations…',
  PRODUCTS: 'Writing your products…',
  VARIATION_TABS: 'Writing a tab for each product…',
  CLEANUP: 'Tidying up…',
  DONE: 'Done',
}

function PushModal({ resumable, onClose, onResumableChange }: {
  resumable: PushStatus | null
  onClose: () => void
  onResumableChange: (s: PushStatus | null) => void
}) {
  const push = useSteppedJob<PushStatus>({
    endpoint: `${BASE}/push`,
    idKey: 'pushJobId',
    noun: 'The push',
    progressOf: (s) => `${s.phase}:${s.tabsDone}`,
    initial: resumable,
  })
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [startErr, setStartErr] = useState<string | null>(null)
  const pushJobId = useRef<string | null>(resumable?.pushJobId ?? null)

  // Kick the push off: POST /push, then loop steps. A 409 with needsConfirm is the
  // edit guard - ask, then retry with force (looped, not recursed). A 409 with a
  // job id means one is already under way; resume it rather than starting a second.
  const startPush = useCallback(async () => {
    setStarting(true)
    setStartErr(null)
    let force = false
    for (;;) {
      const res = await fetch(`${BASE}/push`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409 && body.needsConfirm) {
        setStarting(false)
        if (confirm(`${body.error}\n\nOverwrite the sheet anyway?`)) { force = true; setStarting(true); continue }
        onClose()
        return
      }
      setStarting(false)
      if (res.status === 409 && body.pushJobId) {
        pushJobId.current = body.pushJobId
        if (body.status) push.setStatus(body.status)
        await push.run(body.pushJobId)
        return
      }
      if (!res.ok || !body.pushJobId) { setStartErr(failureText(res, body, 'Push failed to start.')); return }
      pushJobId.current = body.pushJobId
      push.setStatus({
        pushJobId: body.pushJobId, status: 'RUNNING', phase: 'BUILD_PRODUCTS', done: false,
        tabsTotal: body.tabsTotal ?? 0, tabsDone: 0,
        counts: { productsRows: 0, variationsRows: 0, suppliersRows: 0, formulasKept: 0 },
        error: null,
      })
      await push.run(body.pushJobId)
      return
    }
  }, [push, onClose])

  // On open: resume an unfinished push, or start a fresh one. Once per modal open.
  const began = useRef(false)
  useEffect(() => {
    if (began.current) return
    began.current = true
    if (resumable) void push.run(resumable.pushJobId)
    else void (async () => { await Promise.resolve(); await startPush() })()
  }, [resumable, push, startPush])

  useEffect(() => {
    const s = push.status
    if (!s) return
    onResumableChange(s.done ? null : (s.status === 'FAILED' || s.status === 'RUNNING') ? s : null)
  }, [push.status, onResumableChange])

  const abandonPush = useCallback(async (): Promise<PushStatus | null> => {
    const jobId = pushJobId.current ?? push.status?.pushJobId
    const snapshot = await push.abandon(jobId ?? null)
    onResumableChange(null)
    return snapshot
  }, [push, onResumableChange])

  const STOP_PUSH_CONFIRM = 'Stop this push?\n\nTabs already written stay as they are - the rest of the sheet just will not be updated. You can push again whenever you like.'

  async function continuePush() {
    const jobId = pushJobId.current ?? push.status?.pushJobId
    push.allowRestart()
    if (jobId) await push.run(jobId)
  }

  // Same close-means-stop as the Pull dialog: closing this window while the push
  // is unfinished stops the job (after the Stop push confirm) rather than leaving
  // it to be resumed - a half-done push keeps spending Google's quota on every
  // Continue, and an owner who closed the window meant "stop". Closing the whole
  // browser tab still pauses; nothing client-side runs then.
  function requestClose() {
    const s = push.status
    const unfinished = s && !s.done && s.status !== 'CANCELLED'
    if (!unfinished) { onClose(); return }
    if (!confirm(STOP_PUSH_CONFIRM)) return
    void (async () => { await abandonPush(); onClose() })()
  }

  async function stopPush() {
    if (!confirm(STOP_PUSH_CONFIRM)) return
    setStopping(true)
    const snapshot = await abandonPush()
    setStopping(false)
    push.setStatus(snapshot ?? (push.status ? { ...push.status, status: 'CANCELLED' } : null))
  }

  const s = push.status
  const c = s?.counts
  const failed = s?.status === 'FAILED'
  const cancelled = s?.status === 'CANCELLED'
  const building = s?.phase === 'BUILD_PRODUCTS' || s?.phase === 'BUILD_TABS'

  const headline = !s ? (starting ? 'Starting the push…' : 'Preparing…')
    : s.done ? 'Push complete.'
    : cancelled && push.working ? 'Stopping - finishing the tab already under way…'
    : cancelled ? 'Push stopped. The tabs already written stay as they are; the rest of the sheet was left alone.'
    : failed && push.working ? 'Hit a snag - retrying automatically…'
    : failed ? `The push stopped: ${s.error ?? 'unknown error'}. Nothing is lost - press Continue to pick up where it left off.`
    : PUSH_PHASE_LABEL[s.phase]

  return (
    <Modal
      title={cancelled ? 'Push stopped' : s?.done ? 'Push complete' : 'Pushing to your sheet'}
      onClose={requestClose}
      footer={
        !s ? <span style={muted}>Getting ready…</span>
        : s.done || (cancelled && !push.working) ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button>
        ) : cancelled ? (
          <span style={muted}>Stopping… this dialog will settle in a moment.</span>
        ) : push.working ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={stopPush} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop push'}
            </button>
            <span style={muted}>
              {failed ? 'Retrying… stop it if you would rather not wait.' : 'Working… leave this open until it finishes. Closing this window stops the push.'}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={continuePush}>Continue</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await abandonPush(); onClose() }}>Cancel push</button>
          </>
        )
      }
    >
      <RunningLine text={headline} ms={s?.done || cancelled ? 0 : push.elapsedMs} tone={failed && !push.working ? 'danger' : 'normal'} />

      {s && !s.done && !cancelled && <PhasePills steps={PUSH_STEPS} current={s.phase} />}

      {/* While the snapshot is being assembled there is no tab count yet - a bar
          stuck at "0 of 0" would read as nothing happening. Say what it is doing
          instead, and bring the bar in once there is something to count. */}
      {building ? (
        <p style={{ ...muted, fontSize: '0.8125rem' }}>
          Gathering everything the sheet needs. On a big catalogue this is the slowest part - the writing that
          follows is quick.
        </p>
      ) : s ? (
        <ProgressRow label="Product tabs" done={s.tabsDone} total={s.tabsTotal} />
      ) : null}

      {c && !building && (
        <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.75rem' }}>
          {n(c.productsRows, 'product')} written, {n(c.variationsRows, 'variant row')} across {n(s?.tabsDone ?? 0, 'tab')}.
          {c.suppliersRows ? ' Suppliers refreshed.' : ''}
          {c.formulasKept ? ` ${n(c.formulasKept, 'formula')} kept.` : ''}
        </p>
      )}

      {(push.error || startErr) && (
        <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>{push.error ?? startErr}</p>
      )}
    </Modal>
  )
}

// --- Logs --------------------------------------------------------------------

function LogsModal({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<SyncLog[] | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const l = await fetch(`${BASE}/log`).then((r) => r.json()).catch(() => ({ logs: [] }))
      if (!cancelled) setLogs(l.logs ?? [])
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <Modal title="Recent syncs" onClose={onClose} footer={<button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>}>
      {logs == null ? (
        <p style={muted}>Loading…</p>
      ) : logs.length === 0 ? (
        <p style={muted}>No syncs yet. Push to fill the sheet, then pull to bring your edits back.</p>
      ) : (
        <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', ...muted }}>
              <th style={{ padding: '0.25rem 0.5rem 0.25rem 0' }}>When</th>
              <th>Direction</th>
              <th>Tab</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '0.25rem 0.5rem 0.25rem 0', whiteSpace: 'nowrap' }}>{fmt(l.createdAt)}</td>
                <td>{l.direction === 'PUSH' ? 'Push' : 'Pull'}</td>
                <td>{l.tab === 'PRODUCTS' ? 'Products' : 'Variations'}</td>
                <td>
                  {l.status === 'FAILED' ? (
                    <span style={{ color: 'var(--color-danger)' }}>Failed</span>
                  ) : (
                    <>
                      {`+${l.createdCount} new, ${l.updatedCount} updated${l.archivedCount ? `, ${l.archivedCount} ${l.tab === 'VARIATIONS' ? 'removed' : 'deleted'}` : ''}`}
                      {/* Errors judged by the stored rows, not the status, so runs
                          logged as plain COMPLETED before the partial status
                          existed still show their failures. */}
                      {(l.errors?.length ?? 0) > 0 && (
                        <details style={{ display: 'inline-block', marginLeft: '0.375rem' }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--color-warning)', fontWeight: 600 }}>
                            {n(l.errors!.length, 'row')} failed
                          </summary>
                          <ul style={{ ...muted, margin: '0.25rem 0 0.25rem 1rem' }}>
                            {l.errors!.map((e, i) => <li key={i}>Row {e.row}: {e.reason}</li>)}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
