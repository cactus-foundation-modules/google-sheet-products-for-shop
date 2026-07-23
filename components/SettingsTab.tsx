'use client'

import { useCallback, useEffect, useState } from 'react'

type Settings = {
  hasOAuthClient: boolean
  hasOAuthConnected: boolean
  googleAccountEmail: string | null
  spreadsheetId: string | null
  spreadsheetUrl: string | null
  lastPushAt: string | null
  lastPullAt: string | null
  redirectUri: string | null
  siteOrigin: string | null
}

const EMPTY: Settings = {
  hasOAuthClient: false,
  hasOAuthConnected: false,
  googleAccountEmail: null,
  spreadsheetId: null,
  spreadsheetUrl: null,
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

  const refresh = useCallback(async () => {
    const s = await fetch(`${BASE}/settings`).then((r) => r.json())
    setSettings({ ...EMPTY, ...s })
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
      setMessage('Sheet ready. Push and Pull live on the Products page.')
    } else {
      setMessage((await res.json().catch(() => ({}))).error ?? 'Could not create the sheet.')
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
      setMessage('Fresh sheet created. Push (from the Products page) to fill it.')
    } else {
      setMessage(body.error ?? 'Could not reset the sheet.')
    }
  }

  if (loading) return null

  return (
    <div>
      <p style={{ ...muted, marginBottom: '1.5rem' }}>
        Mirror your shop catalogue into a Google Sheet you can bulk-edit, then pull the changes back in.
        This tab is the one-off setup; the day-to-day <strong>Push</strong>, <strong>Pull</strong> and sync log
        live on the <strong>Products</strong> page, under the Google Sheet button.
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
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>The sheet</div>

        <p style={{ ...muted, fontSize: '0.8125rem', marginBottom: '1rem' }}>
          The sheet carries every price you keep, cost price included. Cost price is your supplier cost (your
          margin), so anyone you share the sheet with can see it - share it with that in mind.
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
              Your sheet is set up. Push, Pull and the sync log are on the{' '}
              <strong>Products</strong> page - look for the <strong>Google Sheet</strong> button.
            </p>
            <button type="button" className="btn btn-secondary" onClick={resetSheet} disabled={!!busy}>
              {busy === 'reset' ? 'Resetting…' : 'Reset sheet'}
            </button>
            <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.75rem' }}>
              Last push: {fmt(settings.lastPushAt)} · Last pull: {fmt(settings.lastPullAt)}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
