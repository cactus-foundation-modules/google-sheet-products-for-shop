import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { readGrid, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
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

  // Two failures with nothing in common: Google would not give us the grids, or
  // the catalogue comparison behind them fell over. They were once caught
  // together and both reported as "could not read the Google Sheet", which sent
  // an owner off resetting a spreadsheet that was never the problem - a database
  // blip mid-comparison read as a broken sheet. Caught separately, and each one
  // says what actually happened.
  let productsGrid: string[][]
  let variationsGrid: string[][]
  try {
    ;[productsGrid, variationsGrid] = await Promise.all([
      readGrid(conn.spreadsheetId, TAB.PRODUCTS),
      readGrid(conn.spreadsheetId, TAB.VARIATIONS),
    ])
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    const reason = sheetFailureReason(err)
    console.error('[google-sheet-products-for-shop/preview] sheet read failed:', reason)
    return errorResponse(`Could not read the Google Sheet. ${reason}`, 502)
  }

  try {
    const preview = await buildPullPreview(productsGrid, variationsGrid, conn)
    return NextResponse.json({ preview })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error'
    console.error('[google-sheet-products-for-shop/preview] comparison failed:', reason)
    return errorResponse(`Read the sheet fine, but comparing it with your catalogue failed: ${reason}`, 500)
  }
}
