'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullStatus, PullDetected } from '@/modules/google-sheet-products-for-shop/lib/types'

// The Google Sheet controls, injected onto shop's Products page through the
// `shop.products-toolbar` extension point. A single dropdown (Open / Push / Pull /
// Logs) that only appears once a sheet is connected, plus the two modals the Pull
// and the sync log open into. Setup itself stays on Settings > Google Sheet.

const BASE = '/api/m/google-sheet-products-for-shop/admin'
const muted = { color: 'var(--color-text-muted)' }
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : 'never')

// A failed response carries { error } whenever the route itself answered. It does
// not when the platform answers over the route's head - a 504 at the sixty-second
// ceiling, or a crash before any handler ran - and the fallback text alone then
// reads as a verdict on the sheet, which is exactly what it is not. Say which of
// the two happened.
function failureText(res: Response, body: { error?: unknown }, fallback: string): string {
  if (typeof body.error === 'string' && body.error) return body.error
  if (res.status === 504) return `${fallback} It ran out of time (sixty seconds) before your site answered.`
  return `${fallback} Your site answered with an error (HTTP ${res.status}) rather than a reason.`
}

type Settings = { hasOAuthConnected: boolean; spreadsheetId: string | null; spreadsheetUrl: string | null; lastPullAt: string | null }

type RowError = { row: number; reason: string }
type Change = { field: string; from: string; to: string }
type Preview = {
  products: {
    toCreate: Array<{ sku: string | null; name: string }>
    toUpdate: Array<{ sku: string | null; name: string; changes: Change[] }>
    toDelete: Array<{ id: string; sku: string | null; name: string }>
    unchanged: number
    rowErrors: RowError[]
  }
  variations: { toCreate: number; toUpdate: number; toDelete: number; unchanged: number; rowErrors: RowError[] }
  staleness: { changedSinceLastPush: number; since: string | null }
  headerMissing: string[]
}
type SyncLog = {
  id: string
  direction: 'PUSH' | 'PULL'
  tab: 'PRODUCTS' | 'VARIATIONS'
  status: 'COMPLETED' | 'FAILED'
  createdCount: number
  updatedCount: number
  skippedCount: number
  archivedCount: number
  errors: RowError[] | null
  createdAt: string
}

// Pluralise without the "(s)" crutch - "1 product" / "3 products" reads like a
// person wrote it.
function n(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`
}

export function GoogleSheetProductsToolbar() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modal, setModal] = useState<null | 'pull' | 'logs'>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // An unfinished Pull found on load (or left after a failure) - offer Continue.
  const [resumable, setResumable] = useState<PullStatus | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const loadSettings = useCallback(async () => {
    const s = await fetch(`${BASE}/settings`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (s) setSettings({ hasOAuthConnected: !!s.hasOAuthConnected, spreadsheetId: s.spreadsheetId ?? null, spreadsheetUrl: s.spreadsheetUrl ?? null, lastPullAt: s.lastPullAt ?? null })
  }, [])

  const checkResumable = useCallback(async () => {
    const r = await fetch(`${BASE}/pull/status`).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    setResumable(r?.status && !r.status.done ? r.status : null)
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

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Only render once a sheet is actually connected; setup lives in Settings.
  if (!settings || !settings.hasOAuthConnected || !settings.spreadsheetId) return null

  async function push(force = false) {
    setMenuOpen(false)
    setBusy('push')
    setToast(null)
    const res = await fetch(`${BASE}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(null)
    // The sheet was edited since Cactus last synced it. Let the owner decide
    // whether to overwrite those edits rather than doing it silently.
    if (res.status === 409 && body.needsConfirm) {
      if (confirm(`${body.error}\n\nOverwrite the sheet anyway?`)) await push(true)
      return
    }
    const kept = typeof body.formulasKept === 'number' && body.formulasKept > 0
      ? ` ${body.formulasKept} formula(s) kept.`
      : ''
    const catalogues = typeof body.supplierCatalogues === 'number' && body.supplierCatalogues > 0
      ? ' Supplier catalogues refreshed.'
      : ''
    setToast(res.ok
      ? `Pushed ${body.products} product(s) and ${body.variations} variant row(s) to the sheet.${catalogues}${kept}`
      : failureText(res, body, 'Push failed.'))
  }

  function openPull() {
    setMenuOpen(false)
    setModal('pull')
  }
  function openLogs() {
    setMenuOpen(false)
    setModal('logs')
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy === 'push'}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {busy === 'push' ? 'Pushing…' : 'Google Sheet'} <span aria-hidden style={{ fontSize: '0.7em' }}>▾</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="card"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 0.25rem)', zIndex: 50,
            minWidth: '13rem', padding: '0.35rem', display: 'grid', gap: '0.1rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          {resumable && (
            <button type="button" className="gsp-menu-item" style={{ color: 'var(--color-primary)', fontWeight: 600 }} onClick={openPull} role="menuitem">
              Resume pull…
            </button>
          )}
          {settings.spreadsheetUrl && (
            <a className="gsp-menu-item" href={settings.spreadsheetUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setMenuOpen(false)}>
              Open sheet ↗
            </a>
          )}
          <button type="button" className="gsp-menu-item" onClick={() => push()} role="menuitem">Push to sheet</button>
          <button type="button" className="gsp-menu-item" onClick={openPull} role="menuitem">Pull from sheet…</button>
          <button type="button" className="gsp-menu-item" onClick={openLogs} role="menuitem">Sheet logs</button>
        </div>
      )}

      {toast && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 0.25rem)', zIndex: 40, minWidth: '18rem', fontSize: '0.8125rem' }}>
          {toast}
        </div>
      )}

      {modal === 'pull' && (
        <PullModal
          resumable={resumable}
          onClose={() => { setModal(null); void loadSettings(); void checkResumable() }}
          onResumableChange={setResumable}
        />
      )}
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

// --- Shared modal shell ----------------------------------------------------

function Modal({ title, onClose, children, width = 640 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 1000 }}
    >
      <div className="card" style={{ width: '100%', maxWidth: width, maxHeight: '85vh', overflowY: 'auto', cursor: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// --- Pull modal: preview -> confirm -> live progress -> continue ------------

function bar(done: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.min(100, Math.round((done / total) * 100))}%`
}

function ProgressRow({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div style={{ marginBottom: '0.6rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '0.2rem' }}>
        <span>{label}</span>
        <span style={muted}>{done} of {total}</span>
      </div>
      <div style={{ height: '0.5rem', background: 'var(--color-bg-subtle)', borderRadius: '999px', overflow: 'hidden' }}>
        <div style={{ width: bar(done, total), height: '100%', background: 'var(--color-primary)', transition: 'width 0.3s ease' }} />
      </div>
    </div>
  )
}

const PHASE_LABEL: Record<PullStatus['phase'], string> = {
  PRODUCTS: 'Updating products…',
  DELETIONS: 'Removing items no longer in the sheet…',
  VARIATIONS: 'Updating variations…',
  DONE: 'Done',
}

// Which phases come after this one, for the "Products → Removals → Variations"
// step tracker - so the owner can see there's more to come rather than watching
// one bar and wondering if that's the whole job.
const PHASE_ORDER: PullStatus['phase'][] = ['PRODUCTS', 'DELETIONS', 'VARIATIONS', 'DONE']
const PHASE_SHORT: Record<PullStatus['phase'], string> = {
  PRODUCTS: 'Products', DELETIONS: 'Removals', VARIATIONS: 'Variations', DONE: 'Done',
}

function PhaseTracker({ phase }: { phase: PullStatus['phase'] }) {
  const currentIdx = PHASE_ORDER.indexOf(phase)
  return (
    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem', fontSize: '0.75rem' }}>
      {(['PRODUCTS', 'DELETIONS', 'VARIATIONS'] as const).map((p, i) => {
        const idx = PHASE_ORDER.indexOf(p)
        const state = idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'pending'
        return (
          <div key={p} style={{
            padding: '0.15rem 0.55rem', borderRadius: '999px',
            background: state === 'pending' ? 'var(--color-bg-subtle)' : 'var(--color-primary)',
            color: state === 'pending' ? 'var(--color-text-muted)' : 'var(--color-on-primary)',
            opacity: state === 'done' ? 0.6 : 1, fontWeight: state === 'active' ? 600 : 400,
          }}>
            {state === 'done' ? '✓ ' : ''}{PHASE_SHORT[p]}
          </div>
        )
      })}
    </div>
  )
}

function PullModal({ resumable, onClose, onResumableChange }: { resumable: PullStatus | null; onClose: () => void; onResumableChange: (s: PullStatus | null) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [status, setStatus] = useState<PullStatus | null>(resumable)
  const [pulling, setPulling] = useState(false)
  const [starting, setStarting] = useState(false)
  const pullJobId = useRef<string | null>(resumable?.pullJobId ?? null)
  const pollRef = useRef<number | null>(null)
  const looping = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current != null) { window.clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const startPolling = useCallback((jobId: string) => {
    stopPolling()
    pollRef.current = window.setInterval(async () => {
      const r = await fetch(`${BASE}/pull/status?pullJobId=${jobId}`).then((x) => (x.ok ? x.json() : null)).catch(() => null)
      if (r?.status) setStatus((prev) => (prev?.done ? prev : r.status))
    }, 1500)
  }, [stopPolling])

  // How many times a step may fail in a row before we stop and offer Continue.
  // A failure that follows real progress resets the count, so a long pull with
  // the odd hiccup keeps going; only a genuinely stuck one ever surfaces.
  const MAX_STEP_RETRIES = 5

  const runSteps = useCallback(async (jobId: string) => {
    if (looping.current) return
    looping.current = true
    setPulling(true)
    setLoadErr(null)
    startPolling(jobId)
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
    const progressOf = (s: PullStatus) => `${s.phase}:${s.productsDone}:${s.variationsDone}`
    let retries = 0
    let lastProgress: string | null = null
    try {
      for (;;) {
        let failReason: string | null = null
        try {
          const r = await fetch(`${BASE}/pull/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pullJobId: jobId }) })
          const j = await r.json().catch(() => null)
          if (r.ok && j?.status) {
            setStatus(j.status)
            if (j.status.done) break
            const progress = progressOf(j.status)
            if (progress !== lastProgress) { lastProgress = progress; retries = 0 }
            if (j.status.status !== 'FAILED') continue
            // A FAILED job keeps its cursor; stepping it again retries the same
            // batch, so transient causes (a DB blip, a killed request) self-heal.
            failReason = j.status.error ?? 'The pull hit a snag.'
          } else {
            failReason = j?.error ?? 'The pull could not continue.'
          }
        } catch {
          failReason = 'The connection dropped.' // network hiccup - retry quietly
        }
        retries += 1
        if (retries > MAX_STEP_RETRIES) {
          setLoadErr(`${failReason} It was retried ${MAX_STEP_RETRIES} times without getting further - press Continue to keep trying, or Cancel.`)
          break
        }
        await sleep(Math.min(2000 * retries, 8000))
      }
    } finally {
      looping.current = false
      setPulling(false)
      stopPolling()
    }
  }, [startPolling, stopPolling])

  // Load the preview on open, unless we opened straight into a resumable job.
  useEffect(() => {
    if (resumable) return
    let cancelled = false
    ;(async () => {
      const res = await fetch(`${BASE}/pull/preview`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (cancelled) return
      if (res.ok) setPreview(body.preview)
      else setLoadErr(failureText(res, body, 'Could not read the sheet.'))
    })()
    return () => { cancelled = true }
  }, [resumable])

  useEffect(() => () => stopPolling(), [stopPolling])

  // Opened onto an unfinished job: resume it straight away - the whole point of
  // a resumable pull is that it resumes, not that it waits for a button. Once
  // per modal open; if the auto-run then exhausts its retries, Continue takes over.
  const autoResumed = useRef(false)
  useEffect(() => {
    if (resumable && !autoResumed.current) {
      autoResumed.current = true
      void runSteps(resumable.pullJobId)
    }
  }, [resumable, runSteps])

  // Keep the parent's Continue prompt in step with where we end up.
  useEffect(() => {
    if (!status) return
    onResumableChange(status.done ? null : (status.status === 'FAILED' || status.status === 'RUNNING') ? status : null)
  }, [status, onResumableChange])

  async function startPull() {
    if (!preview) return
    setStarting(true)
    setLoadErr(null)
    // The server re-reads and re-diffs the sheet itself - what it starts is what
    // the sheet says NOW, not what this dialog happened to show. Its own counts
    // come back in the 202 for the progress view.
    const res = await fetch(`${BASE}/pull`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    setStarting(false)
    if (res.status === 409 && body.pullJobId) { pullJobId.current = body.pullJobId; await runSteps(body.pullJobId); return }
    if (!res.ok || !body.pullJobId) { setLoadErr(failureText(res, body, 'Pull failed to start.')); return }
    pullJobId.current = body.pullJobId
    setStatus({
      pullJobId: body.pullJobId, status: 'RUNNING', phase: 'PRODUCTS', done: false,
      productsTotal: body.productsTotal ?? 0, productsDone: 0,
      variationsTotal: body.variationsTotal ?? 0, variationsDone: 0,
      detected: body.detected ?? null,
      counts: { productsCreated: 0, productsUpdated: 0, productsDeleted: 0, variationsCreated: 0, variationsUpdated: 0, variationsDeleted: 0 },
      errorCount: 0, error: null,
    })
    await runSteps(body.pullJobId)
  }

  async function continuePull() {
    const jobId = pullJobId.current ?? status?.pullJobId
    if (jobId) await runSteps(jobId)
  }

  async function cancelPull() {
    const jobId = pullJobId.current ?? status?.pullJobId
    if (jobId) await fetch(`${BASE}/pull/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pullJobId: jobId }) }).catch(() => {})
    onResumableChange(null)
    onClose()
  }

  // ---- render ----
  const title = status ? 'Pulling from your sheet' : 'Pull from sheet'

  // Progress / result view (once a job exists).
  if (status) {
    const c = status.counts
    const failed = status.status === 'FAILED'
    return (
      <Modal title={title} onClose={onClose}>
        {status.done ? (
          <p style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Pull complete.</p>
        ) : failed && pulling ? (
          <p style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Hit a snag - retrying automatically…</p>
        ) : failed ? (
          <p style={{ color: 'var(--color-danger)', fontWeight: 600, marginBottom: '0.75rem' }}>
            The pull stopped: {status.error ?? 'unknown error'}. Nothing is lost - press Continue to pick up where it left off.
          </p>
        ) : (
          <p style={{ fontWeight: 600, marginBottom: '0.75rem' }}>{PHASE_LABEL[status.phase]}</p>
        )}

        {!status.done && <PhaseTracker phase={status.phase} />}

        <ProgressRow label="Products" done={status.productsDone} total={status.productsTotal} />
        <ProgressRow label="Variations" done={status.variationsDone} total={status.variationsTotal} />

        {(status.detected?.productsUnchanged || status.detected?.variationsUnchanged) ? (
          <p style={{ ...muted, fontSize: '0.75rem', marginTop: '-0.35rem', marginBottom: '0.6rem' }}>
            Only rows that actually changed are being touched -
            {' '}{n((status.detected.productsUnchanged ?? 0) + (status.detected.variationsUnchanged ?? 0), 'row')} already matched your sheet and {(status.detected.productsUnchanged ?? 0) + (status.detected.variationsUnchanged ?? 0) === 1 ? 'was' : 'were'} skipped.
          </p>
        ) : null}

        <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.75rem' }}>
          {n(c.productsCreated, 'product')} added, {n(c.productsUpdated, 'product')} updated{c.productsDeleted ? `, ${n(c.productsDeleted, 'product')} deleted` : ''}.
          {' '}{n(c.variationsCreated, 'variation')} added, {n(c.variationsUpdated, 'variation')} updated{c.variationsDeleted ? `, ${n(c.variationsDeleted, 'variation')} removed` : ''}.
          {status.errorCount ? ` ${n(status.errorCount, 'row')} had errors.` : ''}
        </p>

        {loadErr && <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>{loadErr}</p>}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          {status.done ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button>
          ) : failed || !pulling ? (
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={continuePull} disabled={pulling}>{pulling ? 'Working…' : 'Continue'}</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={cancelPull} disabled={pulling}>Cancel pull</button>
            </>
          ) : (
            <span style={muted}>Working… you can leave this open. Closing the tab pauses it - reopen and Continue.</span>
          )}
        </div>
      </Modal>
    )
  }

  // Preview / confirm view (before the first step).
  const p = preview?.products
  const deleteCount = (p?.toDelete.length ?? 0) + (preview?.variations.toDelete ?? 0)
  const totalRows = p ? p.toCreate.length + p.toUpdate.length + p.unchanged + (preview?.variations.toCreate ?? 0) + (preview?.variations.toUpdate ?? 0) + (preview?.variations.unchanged ?? 0) : 0
  const unchangedTotal = (p?.unchanged ?? 0) + (preview?.variations.unchanged ?? 0)
  const changedTotal = totalRows - unchangedTotal
  const nothingToDo = !!p && totalRows > 0 && changedTotal === 0 && deleteCount === 0
  return (
    <Modal title={title} onClose={onClose}>
      {loadErr ? (
        <p style={{ color: 'var(--color-danger)' }}>{loadErr}</p>
      ) : !preview || !p ? (
        <p style={muted}>Reading your sheet and comparing it with your catalogue…</p>
      ) : preview.headerMissing.length > 0 ? (
        <p style={{ color: 'var(--color-danger)' }}>
          Your sheet is missing these columns: {preview.headerMissing.join(', ')}. Fix the header row before pulling.
        </p>
      ) : nothingToDo ? (
        <>
          <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Your sheet already matches your shop.</p>
          <p style={{ ...muted, marginBottom: '1rem' }}>
            Checked {n(totalRows, 'row')} - nothing to create, update, or remove. There is nothing for Pull to do.
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </>
      ) : (
        <>
          <p style={{ ...muted, marginBottom: '0.75rem' }}>
            Checked {n(totalRows, 'row')}{unchangedTotal > 0 ? ` - ${n(unchangedTotal, 'row')} already matched and will be left alone` : ''}. Here is what Pull will actually do:
          </p>

          {preview.staleness.changedSinceLastPush > 0 && (
            <p style={{ fontWeight: 600 }}>
              {n(preview.staleness.changedSinceLastPush, 'product')} changed in the admin since you last pushed. Pulling will overwrite those changes.
            </p>
          )}

          <ul style={{ margin: '0 0 0.75rem 1rem' }}>
            <li>Products: {p.toCreate.length} to create, {p.toUpdate.length} to update{p.toDelete.length ? `, ${p.toDelete.length} to delete` : ''}{p.rowErrors.length ? `, ${n(p.rowErrors.length, 'row')} with errors` : ''}.</li>
            <li>Variations: {preview.variations.toCreate} to create, {preview.variations.toUpdate} to update{preview.variations.toDelete ? `, ${preview.variations.toDelete} to remove` : ''}{preview.variations.rowErrors.length ? `, ${n(preview.variations.rowErrors.length, 'row')} with errors` : ''}.</li>
          </ul>

          {preview.variations.toDelete > 0 && (
            <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>
              {n(preview.variations.toDelete, 'variation is', 'variations are')} on your site but no longer in the sheet. Pulling removes {preview.variations.toDelete === 1 ? 'it' : 'them'} for good.
            </p>
          )}

          {(p.rowErrors.length > 0 || preview.variations.rowErrors.length > 0) && (
            <details style={{ marginBottom: '0.75rem' }}>
              <summary style={{ cursor: 'pointer' }}>Row errors</summary>
              <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.5rem 0 0 1rem' }}>
                {p.rowErrors.map((e, i) => <li key={`p${i}`}>Products row {e.row}: {e.reason}</li>)}
                {preview.variations.rowErrors.map((e, i) => <li key={`v${i}`}>Variations row {e.row}: {e.reason}</li>)}
              </ul>
            </details>
          )}

          {p.toUpdate.length > 0 && (
            <details style={{ marginBottom: '0.75rem' }}>
              <summary style={{ cursor: 'pointer' }}>What&apos;s changing on {n(p.toUpdate.length, 'product')}</summary>
              <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.5rem 0 0 1rem' }}>
                {p.toUpdate.slice(0, 25).map((m, i) => (
                  <li key={i}>
                    {m.name}{m.sku ? ` (${m.sku})` : ''}: {m.changes.map((c) => `${c.field} "${c.from}" → "${c.to}"`).join(', ')}
                  </li>
                ))}
                {p.toUpdate.length > 25 && <li>…and {n(p.toUpdate.length - 25, 'more')}.</li>}
              </ul>
            </details>
          )}

          {p.toDelete.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--color-danger)' }}>In the shop but not in your sheet</div>
              <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>
                {n(p.toDelete.length, 'product')} will be permanently deleted on Pull, together with any of their variations. This cannot be undone.
              </p>
              <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.25rem 0 0 1rem' }}>
                {p.toDelete.map((m) => <li key={m.id}>{m.name}{m.sku ? ` (${m.sku})` : ''}</li>)}
              </ul>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={startPull} disabled={starting}>
              {starting ? 'Starting…' : `Pull${deleteCount ? ` and delete ${deleteCount}` : ''}`}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={starting}>Cancel</button>
          </div>
        </>
      )}
    </Modal>
  )
}

// --- Logs modal: the Recent syncs table --------------------------------------

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
    <Modal title="Recent syncs" onClose={onClose}>
      {logs == null ? (
        <p style={muted}>Loading…</p>
      ) : logs.length === 0 ? (
        <p style={muted}>No syncs yet.</p>
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
                <td style={{ padding: '0.25rem 0.5rem 0.25rem 0' }}>{fmt(l.createdAt)}</td>
                <td>{l.direction === 'PUSH' ? 'Push' : 'Pull'}</td>
                <td>{l.tab === 'PRODUCTS' ? 'Products' : 'Variations'}</td>
                <td>
                  {l.status === 'FAILED'
                    ? <span style={{ color: 'var(--color-danger)' }}>Failed</span>
                    : `+${l.createdCount} new, ${l.updatedCount} updated${l.archivedCount ? `, ${l.archivedCount} ${l.tab === 'VARIATIONS' ? 'removed' : 'deleted'}` : ''}${l.errors?.length ? `, ${l.errors.length} error(s)` : ''}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
