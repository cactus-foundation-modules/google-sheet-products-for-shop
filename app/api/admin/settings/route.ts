import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getConnection, saveOAuthClient, setIncludeCostPrice } from '@/modules/google-sheet-products-for-shop/lib/db'
import { buildGoogleRedirectUri } from '@/modules/google-sheet-products-for-shop/lib/oauth-google'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  const siteUrl = getSiteUrlOrNull()

  // Never return decrypted secrets to the client - only whether they're set.
  return NextResponse.json({
    hasOAuthClient: !!(conn?.oauthClientIdEncrypted && conn?.oauthClientSecretEncrypted),
    hasOAuthConnected: !!conn?.oauthRefreshTokenEncrypted,
    googleAccountEmail: conn?.googleAccountEmail ?? null,
    spreadsheetId: conn?.spreadsheetId ?? null,
    spreadsheetUrl: conn?.spreadsheetUrl ?? null,
    includeCostPrice: conn?.includeCostPrice ?? true,
    lastPushAt: conn?.lastPushAt ?? null,
    lastPullAt: conn?.lastPullAt ?? null,
    // The two values the owner must paste into their Google OAuth client. The
    // redirect URI is the one Google checks byte-for-byte - a mismatch here is
    // the redirect_uri_mismatch error. Null only if SITE_URL is unset.
    redirectUri: siteUrl ? buildGoogleRedirectUri(siteUrl) : null,
    siteOrigin: siteUrl,
  })
}

const Body = z.object({
  oauthClientId: z.string().min(1).optional(),
  oauthClientSecret: z.string().min(1).optional(),
  includeCostPrice: z.boolean().optional(),
})

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  if (!process.env.ENCRYPTION_KEY) {
    return errorResponse('ENCRYPTION_KEY is not set. Add it to your environment before connecting Google.', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')
  const data = parsed.data

  // Client id and secret are saved as a pair - one without the other cannot start
  // an OAuth flow, so reject a half-save rather than storing a dead credential.
  if ((data.oauthClientId && !data.oauthClientSecret) || (!data.oauthClientId && data.oauthClientSecret)) {
    return errorResponse('Enter both the client ID and the client secret.')
  }
  if (data.oauthClientId && data.oauthClientSecret) {
    await saveOAuthClient(data.oauthClientId, data.oauthClientSecret)
  }
  if (data.includeCostPrice !== undefined) {
    await setIncludeCostPrice(data.includeCostPrice)
  }

  return NextResponse.json({ ok: true })
}
