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

type Settings = { hasOAuthConnected: boolean; spreadsheetId: string | null; spreadsheetUrl: string | null; lastPullAt: string | null }

type RowError = { row: number; reason: string }
type Change = { field: string; from: string; to: string }
type Preview = {
  products: {
    toCreate: Array<{ sku: string | null; name: string }>
    toUpdate: Array<{ sku: string | null; name: string; changes: Change[] }>
    toDelete: Array<{ id: string; sku: string | null; name: string }>
    rowErrors: RowError[]
  }
  variations: { toCreate: number; toUpdate: number; toDelete: number; rowErrors: RowError[] }
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

function detectedFromPreview(p: Preview): PullDetected {
  return {
    productsCreate: p.products.toCreate.length,
    productsUpdate: p.products.toUpdate.length,
    productsDelete: p.products.toDelete.length,
    variationsCreate: p.variations.toCreate,
    variationsUpdate: p.variations.toUpdate,
    variationsDelete: p.variations.toDelete,
  }
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
    setToast(res.ok
      ? `Pushed ${body.products} product(s) and ${body.variations} variant row(s) to the sheet.`
      : (body.error ?? 'Push failed.'))
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

function PullModal({ resumable, onClose, onResumableChange }: { resumable: PullStatus | null; onClose: () => void; onResumableChange: (s: PullStatus | null) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [status, setStatus] = useState<PullStatus | null>(resumable)
  const [pulling, setPulling] = useState(false)
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
      else setLoadErr(body.error ?? 'Could not read the sheet.')
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
    const detected = detectedFromPreview(preview)
    setLoadErr(null)
    const res = await fetch(`${BASE}/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detected }) })
    const body = await res.json().catch(() => ({}))
    if (res.status === 409 && body.pullJobId) { pullJobId.current = body.pullJobId; await runSteps(body.pullJobId); return }
    if (!res.ok || !body.pullJobId) { setLoadErr(body.error ?? 'Pull failed to start.'); return }
    pullJobId.current = body.pullJobId
    setStatus({
      pullJobId: body.pullJobId, status: 'RUNNING', phase: 'PRODUCTS', done: false,
      productsTotal: body.productsTotal ?? 0, productsDone: 0,
      variationsTotal: body.variationsTotal ?? 0, variationsDone: 0,
      detected, counts: { productsCreated: 0, productsUpdated: 0, productsDeleted: 0, variationsCreated: 0, variationsUpdated: 0, variationsDeleted: 0 },
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

        <ProgressRow label="Products" done={status.productsDone} total={status.productsTotal} />
        <ProgressRow label="Variations" done={status.variationsDone} total={status.variationsTotal} />

        <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.75rem' }}>
          {c.productsCreated} product(s) added, {c.productsUpdated} updated{c.productsDeleted ? `, ${c.productsDeleted} deleted` : ''}.
          {' '}{c.variationsCreated} variation(s) added, {c.variationsUpdated} updated{c.variationsDeleted ? `, ${c.variationsDeleted} removed` : ''}.
          {status.errorCount ? ` ${status.errorCount} row(s) had errors.` : ''}
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
  return (
    <Modal title={title} onClose={onClose}>
      {loadErr ? (
        <p style={{ color: 'var(--color-danger)' }}>{loadErr}</p>
      ) : !preview || !p ? (
        <p style={muted}>Reading your sheet…</p>
      ) : preview.headerMissing.length > 0 ? (
        <p style={{ color: 'var(--color-danger)' }}>
          Your sheet is missing these columns: {preview.headerMissing.join(', ')}. Fix the header row before pulling.
        </p>
      ) : (
        <>
          <p style={{ ...muted, marginBottom: '0.75rem' }}>Nothing has changed yet. Here is what Pull will do:</p>

          {preview.staleness.changedSinceLastPush > 0 && (
            <p style={{ fontWeight: 600 }}>
              {preview.staleness.changedSinceLastPush} product(s) changed in the admin since you last pushed. Pulling will overwrite those changes.
            </p>
          )}

          <ul style={{ margin: '0 0 0.75rem 1rem' }}>
            <li>Products: {p.toCreate.length} to create, {p.toUpdate.length} to update{p.toDelete.length ? `, ${p.toDelete.length} to delete` : ''}{p.rowErrors.length ? `, ${p.rowErrors.length} row(s) with errors` : ''}.</li>
            <li>Variations: {preview.variations.toCreate} to create, {preview.variations.toUpdate} to update{preview.variations.toDelete ? `, ${preview.variations.toDelete} to remove` : ''}{preview.variations.rowErrors.length ? `, ${preview.variations.rowErrors.length} row(s) with errors` : ''}.</li>
          </ul>

          {preview.variations.toDelete > 0 && (
            <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>
              {preview.variations.toDelete} variation(s) are on your site but no longer in the sheet. Pulling removes them for good.
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

          {p.toDelete.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--color-danger)' }}>In the shop but not in your sheet</div>
              <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem' }}>
                These {p.toDelete.length} product(s) will be permanently deleted on Pull, together with any of their variations. This cannot be undone.
              </p>
              <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.25rem 0 0 1rem' }}>
                {p.toDelete.map((m) => <li key={m.id}>{m.name}{m.sku ? ` (${m.sku})` : ''}</li>)}
              </ul>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={startPull}>
              Pull{deleteCount ? ` and delete ${deleteCount}` : ''}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
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
