import { getOAuthClient, getTokens, updateAccessToken } from '@/modules/google-sheet-products-for-shop/lib/db'
import { refreshGoogleToken } from '@/modules/google-sheet-products-for-shop/lib/oauth-google'

// A connection problem that the site owner can act on, phrased for them rather
// than as a stack trace. The "Testing mode" line is deliberate: a consent screen
// left in Testing hands out refresh tokens that expire after 7 days, which
// presents as "it worked all week then stopped" - and this single message is
// what deflects most of that support load.
export class GoogleAuthError extends Error {}

const DISCONNECTED_MSG =
  'Google has disconnected. This usually means the OAuth consent screen is still in Testing mode (Testing-mode refresh tokens expire after 7 days) - publish it to "In production" and reconnect. See the setup guide.'

// Returns a usable access token, refreshing first when the stored one is within
// 60s of expiry (or when `force` is set, after a 401). The refresh token is
// never returned by Google on refresh, so updateAccessToken leaves it in place.
export async function getAccessToken(force = false): Promise<string> {
  const tokens = await getTokens()
  if (!tokens || !tokens.refreshToken) {
    throw new GoogleAuthError('Not connected to Google. Connect an account on the settings page first.')
  }

  const stillValid = !!tokens.accessToken && !!tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() > 60_000
  if (!force && stillValid && tokens.accessToken) return tokens.accessToken

  const client = await getOAuthClient()
  if (!client) throw new GoogleAuthError('Google app credentials are missing. Re-save them on the settings page.')

  try {
    const refreshed = await refreshGoogleToken({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: tokens.refreshToken,
    })
    await updateAccessToken({ accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt })
    return refreshed.accessToken
  } catch (err) {
    // Message only - the thrown error can carry Google's whole response body,
    // which may echo the client secret straight into the log.
    console.error(
      '[google-sheet-products-for-shop/token] refresh failed:',
      err instanceof Error ? err.message : 'Unknown error'
    )
    throw new GoogleAuthError(DISCONNECTED_MSG)
  }
}
