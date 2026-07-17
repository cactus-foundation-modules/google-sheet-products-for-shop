import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { getOAuthClient, storeTokens } from '@/modules/google-sheet-products-for-shop/lib/db'
import { buildGoogleRedirectUri, exchangeGoogleCode, fetchGoogleAccountEmail } from '@/modules/google-sheet-products-for-shop/lib/oauth-google'

async function settingsRedirect(request: NextRequest, query: string): Promise<NextResponse> {
  const config = await prisma.siteConfig.findUnique({ where: { id: 'singleton' }, select: { adminPath: true } })
  const adminPath = config?.adminPath ?? ''
  const res = NextResponse.redirect(new URL(`/${adminPath}/config?tab=google-sheet-products-for-shop&${query}`, request.url))
  res.cookies.delete('cactus_gsp_oauth_state')
  return res
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return NextResponse.redirect(new URL('/', request.url))

  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const storedState = request.cookies.get('cactus_gsp_oauth_state')?.value

  // Verify state against the cookie before doing anything else.
  if (!code || !state || !storedState || state !== storedState) {
    return settingsRedirect(request, 'oauth=error&reason=state_mismatch')
  }

  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return settingsRedirect(request, 'oauth=error&reason=site_url_missing')

  const client = await getOAuthClient()
  if (!client) return settingsRedirect(request, 'oauth=error&reason=client_missing')

  try {
    const redirectUri = buildGoogleRedirectUri(siteUrl)
    const tokens = await exchangeGoogleCode({ clientId: client.clientId, clientSecret: client.clientSecret, redirectUri, code })

    // access_type=offline + prompt=consent should always yield a refresh token
    // on this first exchange; if Google returned none, fail loudly rather than
    // storing a connection that dies in an hour.
    if (!tokens.refreshToken) {
      return settingsRedirect(request, 'oauth=error&reason=no_refresh_token')
    }

    const email = await fetchGoogleAccountEmail(tokens.accessToken)
    await storeTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      googleAccountEmail: email,
    })
  } catch (err) {
    // Message only - the thrown error can carry Google's whole response body,
    // which may echo back the client secret or a partial token.
    console.error(
      '[google-sheet-products-for-shop/oauth] token exchange failed:',
      err instanceof Error ? err.message : 'Unknown error'
    )
    return settingsRedirect(request, 'oauth=error&reason=token_exchange')
  }

  return settingsRedirect(request, 'oauth=connected')
}
