import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { readGrid } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { buildPullPreview } from '@/modules/google-sheet-products-for-shop/lib/preview'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Reads both tabs, resolves them against the DB, returns a summary, writes
// NOTHING. The confirm dialog lists exactly this before POST /pull runs it.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  try {
    const [productsGrid, variationsGrid] = await Promise.all([
      readGrid(conn.spreadsheetId, TAB.PRODUCTS),
      readGrid(conn.spreadsheetId, TAB.VARIATIONS),
    ])
    const preview = await buildPullPreview(productsGrid, variationsGrid, conn)
    return NextResponse.json({ preview })
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    console.error('[google-sheet-products-for-shop/preview] failed:', err instanceof Error ? err.message : 'Unknown error')
    return errorResponse('Could not read the Google Sheet. Please try again.', 502)
  }
}
