// Google OAuth (site owner registers their own Google Cloud project - no CASA /
// brand-review gate for this scope combination).
//
// Scope: drive.file grants access ONLY to files this app itself creates, which
// is why the module makes the spreadsheet rather than accepting a link to an
// existing one. `openid email` are non-sensitive identity scopes, added solely
// so we can show "connected as ..." - they do not change the drive.file data
// boundary and need no verification either.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file'

export function buildGoogleAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: GOOGLE_SCOPE,
    state: opts.state,
    // access_type=offline + prompt=consent are BOTH required: Google only
    // returns a refresh token on first consent otherwise, so a reconnect would
    // silently yield no refresh token and the integration would die an hour
    // later looking like our bug. Non-negotiable.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

export type GoogleTokens = {
  accessToken: string
  // Present on the initial code exchange; null on a refresh (Google reuses the
  // existing one). Callers must keep the stored refresh token when this is null.
  refreshToken: string | null
  expiresAt: Date
}

async function requestToken(body: URLSearchParams): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google OAuth token request failed: ${res.status} ${text}`)
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  }
}

export async function exchangeGoogleCode(opts: {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
}): Promise<GoogleTokens> {
  return requestToken(
    new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
      code: opts.code,
    })
  )
}

export async function refreshGoogleToken(opts: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): Promise<GoogleTokens> {
  return requestToken(
    new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    })
  )
}

// Best-effort: the email is display-only ("connected as ..."), so a failure here
// must never block a successful connection - we just store null.
export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { email?: string }
    return data.email ?? null
  } catch {
    return null
  }
}
