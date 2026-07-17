import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { clearTokens } from '@/modules/google-sheet-products-for-shop/lib/db'

// Drops the OAuth tokens and connected-account display. The client id/secret and
// the spreadsheet pointer are kept, so reconnecting is one click.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  await clearTokens()
  return NextResponse.json({ ok: true })
}
