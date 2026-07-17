import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getOAuthClient } from '@/modules/google-sheet-products-for-shop/lib/db'
import { buildGoogleAuthUrl } from '@/modules/google-sheet-products-for-shop/lib/oauth-google'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return errorResponse('SITE_URL is not configured', 503)

  const client = await getOAuthClient()
  if (!client) return errorResponse('Save your Google app client ID and secret on the settings page first.', 400)

  const state = randomBytes(32).toString('hex')
  const redirectUri = `${siteUrl.replace(/\/$/, '')}/api/m/google-sheet-products-for-shop/admin/oauth/google/callback`

  const res = NextResponse.json({
    authorizeUrl: buildGoogleAuthUrl({ clientId: client.clientId, redirectUri, state }),
  })

  const isProduction = process.env.NODE_ENV === 'production'
  res.cookies.set('cactus_gsp_oauth_state', state, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  return res
}
