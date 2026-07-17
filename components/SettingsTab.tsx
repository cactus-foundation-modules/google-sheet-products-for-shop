'use client'

import { useCallback, useEffect, useState } from 'react'

type Settings = {
  hasOAuthClient: boolean
  hasOAuthConnected: boolean
  googleAccountEmail: string | null
  spreadsheetId: string | null
  spreadsheetUrl: string | null
  includeCostPrice: boolean
  lastPushAt: string | null
  lastPullAt: string | null
  redirectUri: string | null
  siteOrigin: string | null
}

type RowError = { row: number; reason: string }
type Change = { field: string; from: string; to: string }
type Preview = {
  products: {
    toCreate: Array<{ sku: string | null; name: string }>
    toUpdate: Array<{ sku: string | null; name: string; changes: Change[] }>
    missingFromSheet: Array<{ id: string; sku: string; name: string; status: string }>
    rowErrors: RowError[]
  }
  variations: { toCreate: number; toUpdate: number; rowErrors: RowError[] }
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

const EMPTY: Settings = {
  hasOAuthClient: false,
  hasOAuthConnected: false,
  googleAccountEmail: null,
  spreadsheetId: null,
  spreadsheetUrl: null,
  includeCostPrice: true,
  lastPushAt: null,
  lastPullAt: null,
  redirectUri: null,
  siteOrigin: null,
}

const BASE = '/api/m/google-sheet-products-for-shop/admin'
const muted = { color: 'var(--color-text-muted)' }
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : 'never')

// A read-only value with a Copy button, for the exact strings the owner must
// paste into Google. The value is the whole point of the fix, so it stays fully
// visible and selectable even if the clipboard API is blocked.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked (e.g. non-HTTPS context) - the value is still on
      // screen for the owner to select and copy by hand.
    }
  }
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <div style={{ ...muted, fontSize: '0.75rem', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
        <code
          style={{
            flex: 1,
            minWidth: 0,
            padding: '0.5rem 0.625rem',
            background: 'var(--color-bg-subtle)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.8125rem',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            userSelect: 'all',
          }}
        >
          {value}
        </code>
        <button type="button" className="btn btn-secondary" onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export function GoogleSheetSettingsTab() {
  const [settings, setSettings] = useState<Settings>(EMPTY)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    if (params.get('oauth') === 'connected') return 'Google account connected.'
    if (params.get('oauth') === 'error') return `Google connection failed (${params.get('reason') ?? 'unknown error'}).`
    return null
  })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [archive, setArchive] = useState<Set<string>>(new Set())
  const [logs, setLogs] = useState<SyncLog[]>([])

  const refresh = useCallback(async () => {
    const [s, l] = await Promise.all([
      fetch(`${BASE}/settings`).then((r) => r.json()),
      fetch(`${BASE}/log`).then((r) => r.json()).catch(() => ({ logs: [] })),
    ])
    setSettings({ ...EMPTY, ...s })
    setLogs(l.logs ?? [])
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [refresh])

  async function saveClient(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    const res = await fetch(`${BASE}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oauthClientId: clientId || undefined, oauthClientSecret: clientSecret || undefined }),
    })
    setSaving(false)
    if (res.ok) {
      setClientId('')
      setClientSecret('')
      setMessage('Saved.')
      await refresh()
    } else {
      setMessage((await res.json().catch(() => ({}))).error ?? 'Save failed.')
    }
  }

  async function toggleCostPrice(value: boolean) {
    setSettings((s) => ({ ...s, includeCostPrice: value }))
    await fetch(`${BASE}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeCostPrice: value }),
    })
  }

  async function connect() {
    const res = await fetch(`${BASE}/oauth/google/start`)
    if (!res.ok) {
      setMessage((await res.json().catch(() => ({}))).error ?? 'Could not start the Google connection.')
      return
    }
    window.location.href = (await res.json()).authorizeUrl
  }

  async function disconnect() {
    setBusy('disconnect')
    await fetch(`${BASE}/disconnect`, { method: 'POST' })
    setBusy(null)
    await refresh()
    setMessage('Google account disconnected.')
  }

  async function createSheet() {
    setBusy('sheet')
    setMessage(null)
    const res = await fetch(`${BASE}/sheet`, { method: 'POST' })
    setBusy(null)
    if (res.ok) {
      await refresh()
      setMessage('Sheet ready.')
    } else {
      setMessage((await res.json().catch(() => ({}))).error ?? 'Could not create the sheet.')
    }
  }

  async function push() {
    setBusy('push')
    setMessage(null)
    const res = await fetch(`${BASE}/push`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    setBusy(null)
    if (res.ok) {
      setMessage(`Pushed ${body.products} product(s) and ${body.variations} variant row(s) to the sheet.`)
      await refresh()
    } else {
      setMessage(body.error ?? 'Push failed.')
    }
  }

  async function resetSheet() {
    if (!window.confirm('Create a fresh, blank sheet? The current one stays in your Google Drive but is disconnected from Cactus. Push again to refill the new one.')) return
    setBusy('reset')
    setMessage(null)
    const res = await fetch(`${BASE}/reset`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    setBusy(null)
    if (res.ok) {
      await refresh()
      setMessage('Fresh sheet created. Push to fill it.')
    } else {
      setMessage(body.error ?? 'Could not reset the sheet.')
    }
  }

  async function loadPreview() {
    setBusy('preview')
    setMessage(null)
    const res = await fetch(`${BASE}/pull/preview`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    setBusy(null)
    if (res.ok) {
      setPreview(body.preview)
      setArchive(new Set())
    } else {
      setMessage(body.error ?? 'Could not read the sheet.')
    }
  }

  async function confirmPull() {
    if (!preview) return
    setBusy('pull')
    setMessage(null)
    const beforeIds = new Set(logs.map((l) => l.id))
    const res = await fetch(`${BASE}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveSkus: [...archive] }),
    })
    if (!res.ok) {
      setBusy(null)
      setMessage((await res.json().catch(() => ({}))).error ?? 'Pull failed to start.')
      return
    }
    setPreview(null)
    setMessage('Pulling… this runs in the background.')
    // Poll the sync log until a fresh PULL entry lands (the pull writes its
    // result rows when the background run finishes).
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const l = await fetch(`${BASE}/log`).then((r) => r.json()).catch(() => ({ logs: [] }))
      const fresh: SyncLog[] = (l.logs ?? []).filter((x: SyncLog) => x.direction === 'PULL' && !beforeIds.has(x.id))
      setLogs(l.logs ?? [])
      if (fresh.length) {
        const failed = fresh.find((x) => x.status === 'FAILED')
        setMessage(failed ? `Pull failed: ${failed.errors?.[0]?.reason ?? 'unknown error'}` : 'Pull complete.')
        break
      }
    }
    setBusy(null)
    await refresh()
  }

  if (loading) return null

  const p = preview?.products
  const canArchive = (p?.missingFromSheet.length ?? 0) > 0

  return (
    <div>
      <p style={{ ...muted, marginBottom: '1.5rem' }}>
        Mirror your shop catalogue into a Google Sheet you can bulk-edit, then pull the changes back in.
        Nothing here is live: the sheet only changes when you press Push, and your site only changes when
        you press Pull - and Pull shows you exactly what it will do first.
      </p>

      {message && <div className="card" style={{ marginBottom: '1rem' }}>{message}</div>}

      {/* --- Google connection --- */}
      <form onSubmit={saveClient} className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Google account</div>
        <p style={{ ...muted, fontSize: '0.875rem', marginBottom: '0.75rem' }}>
          This is a one-off setup. You make your own free project in Google&rsquo;s console so the sheet lives in
          your Google Drive, under your control. Work through these steps in the{' '}
          <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>Google Cloud console</a>{' '}
          (open it in another tab), then come back here.
        </p>
        <ol style={{ fontSize: '0.875rem', margin: '0 0 0.75rem 1.1rem', display: 'grid', gap: '0.4rem' }}>
          <li>Top-left, click the project menu and <strong>New Project</strong>. Name it anything (e.g. &ldquo;My Shop Sheet&rdquo;) and create it. Make sure it&rsquo;s selected before carrying on.</li>
          <li>Go to <strong>APIs &amp; Services &rarr; Library</strong>. Search <strong>Google Sheets API</strong> and click <strong>Enable</strong>. Do the same for <strong>Google Drive API</strong>.</li>
          <li>Go to <strong>APIs &amp; Services &rarr; OAuth consent screen</strong>. Choose <strong>External</strong>, fill in an app name and your email where asked, and save. Then <strong>publish</strong> it (see the warning below).</li>
          <li>Go to <strong>APIs &amp; Services &rarr; Credentials &rarr; Create credentials &rarr; OAuth client ID</strong>. For <strong>Application type</strong> pick <strong>Web application</strong>.</li>
          <li>
            In <strong>Authorised redirect URIs</strong>, click <strong>Add URI</strong> and paste the address below <em>exactly</em>. This one line is what stops the
            &ldquo;redirect_uri_mismatch&rdquo; error - one wrong character and Google refuses.
            {settings.redirectUri
              ? <CopyField label="Authorised redirect URI - paste into Google" value={settings.redirectUri} />
              : <p style={{ color: 'var(--color-warning)', fontSize: '0.8125rem', marginTop: '0.25rem' }}>Your site address isn&rsquo;t configured yet, so we can&rsquo;t show the exact URL to paste. Contact your administrator.</p>}
            {settings.siteOrigin && (
              <>
                <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.5rem', marginBottom: 0 }}>
                  If Google also asks for <strong>Authorised JavaScript origins</strong>, add this:
                </p>
                <CopyField label="Authorised JavaScript origin (only if asked)" value={settings.siteOrigin} />
              </>
            )}
          </li>
          <li>Click <strong>Create</strong>. Google shows your <strong>Client ID</strong> and <strong>Client secret</strong> - copy both and paste them below.</li>
        </ol>
        <p style={{ fontSize: '0.875rem', fontWeight: 700, background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-border)', borderRadius: 'var(--radius-sm)', padding: '0.625rem 0.75rem' }}>
          Important: on the consent screen, set it to <strong>&ldquo;In production&rdquo;</strong>, not &ldquo;Testing&rdquo;. Testing-mode
          access expires after 7 days - which looks like &ldquo;it worked all week then stopped&rdquo;. With these
          scopes, publishing is one button and needs no Google review.
        </p>
        <div className="field">
          <label>
            Client ID {settings.hasOAuthClient && <span style={{ ...muted, fontWeight: 400 }}>(already set - leave blank to keep it)</span>}
          </label>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label>Client secret</label>
          <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save credentials'}</button>
          {settings.hasOAuthClient && (
            <button type="button" className="btn btn-secondary" onClick={connect}>
              {settings.hasOAuthConnected ? 'Reconnect Google' : 'Connect Google'}
            </button>
          )}
          {settings.hasOAuthConnected && (
            <button type="button" className="btn btn-secondary" onClick={disconnect} disabled={busy === 'disconnect'}>Disconnect</button>
          )}
          {settings.hasOAuthConnected && settings.googleAccountEmail && (
            <span style={{ ...muted, fontSize: '0.875rem' }}>Connected as {settings.googleAccountEmail}</span>
          )}
        </div>
      </form>

      {/* --- The sheet --- */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>The sheet</div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400, marginBottom: '0.5rem' }}>
          <input type="checkbox" checked={settings.includeCostPrice} onChange={(e) => toggleCostPrice(e.target.checked)} />
          Include cost price
        </label>
        <p style={{ ...muted, fontSize: '0.8125rem', marginBottom: '1rem' }}>
          Cost price is your supplier cost (your margin). Anyone you share the sheet with can see it. Turn this
          off and Push again to drop the column entirely.
        </p>

        {!settings.hasOAuthConnected ? (
          <p style={muted}>Connect a Google account above first.</p>
        ) : !settings.spreadsheetId ? (
          <button type="button" className="btn btn-primary" onClick={createSheet} disabled={busy === 'sheet'}>
            {busy === 'sheet' ? 'Creating…' : 'Create the sheet'}
          </button>
        ) : (
          <>
            <p style={{ marginBottom: '0.75rem' }}>
              <a href={settings.spreadsheetUrl ?? '#'} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>Open the sheet ↗</a>
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={push} disabled={!!busy}>
                {busy === 'push' ? 'Pushing…' : 'Push to sheet'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={loadPreview} disabled={!!busy}>
                {busy === 'preview' ? 'Reading…' : 'Pull from sheet…'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={resetSheet} disabled={!!busy}>
                {busy === 'reset' ? 'Resetting…' : 'Reset sheet'}
              </button>
            </div>
            <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.75rem' }}>
              Last push: {fmt(settings.lastPushAt)} · Last pull: {fmt(settings.lastPullAt)}
            </p>
          </>
        )}
      </div>

      {/* --- Pull preview / confirm --- */}
      {preview && p && (
        <div className="card" style={{ marginBottom: '1.5rem', borderColor: 'var(--color-primary)' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Pull preview - nothing has changed yet</div>

          {preview.headerMissing.length > 0 ? (
            <p style={{ color: 'var(--color-danger)' }}>
              Your sheet is missing these columns: {preview.headerMissing.join(', ')}. Fix the header row before pulling.
            </p>
          ) : (
            <>
              {preview.staleness.changedSinceLastPush > 0 && (
                <p style={{ fontWeight: 600 }}>
                  {preview.staleness.changedSinceLastPush} product(s) changed in the admin since you last pushed.
                  Pulling will overwrite those changes.
                </p>
              )}

              <ul style={{ margin: '0 0 0.75rem 1rem' }}>
                <li>Products: {p.toCreate.length} to create, {p.toUpdate.length} to update{p.rowErrors.length ? `, ${p.rowErrors.length} row(s) with errors` : ''}.</li>
                <li>Variations: {preview.variations.toCreate} to create, {preview.variations.toUpdate} to update{preview.variations.rowErrors.length ? `, ${preview.variations.rowErrors.length} row(s) with errors` : ''}.</li>
              </ul>

              {(p.rowErrors.length > 0 || preview.variations.rowErrors.length > 0) && (
                <details style={{ marginBottom: '0.75rem' }}>
                  <summary style={{ cursor: 'pointer' }}>Row errors</summary>
                  <ul style={{ ...muted, fontSize: '0.8125rem', margin: '0.5rem 0 0 1rem' }}>
                    {p.rowErrors.map((e, i) => <li key={`p${i}`}>Products row {e.row}: {e.reason}</li>)}
                    {preview.variations.rowErrors.map((e, i) => <li key={`v${i}`}>Variations row {e.row}: {e.reason}</li>)}
                  </ul>
                </details>
              )}

              {canArchive && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontWeight: 600 }}>In the shop but not in your sheet</div>
                  <p style={{ ...muted, fontSize: '0.8125rem' }}>
                    These are left alone by default. Tick any you want to archive (reversible - never deleted).
                  </p>
                  {p.missingFromSheet.map((m) => (
                    <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        checked={archive.has(m.sku)}
                        onChange={(e) => setArchive((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(m.sku)
                          else next.delete(m.sku)
                          return next
                        })}
                      />
                      {m.name} <span style={muted}>({m.sku})</span>
                    </label>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button type="button" className="btn btn-primary" onClick={confirmPull} disabled={busy === 'pull'}>
                  {busy === 'pull' ? 'Pulling…' : `Pull${archive.size ? ` and archive ${archive.size}` : ''}`}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setPreview(null)} disabled={busy === 'pull'}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* --- Recent activity --- */}
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Recent syncs</div>
        {logs.length === 0 ? (
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
                      : `+${l.createdCount} new, ${l.updatedCount} updated${l.archivedCount ? `, ${l.archivedCount} archived` : ''}${l.errors?.length ? `, ${l.errors.length} error(s)` : ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
