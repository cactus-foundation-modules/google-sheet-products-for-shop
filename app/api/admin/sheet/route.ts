import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection, setSpreadsheet } from '@/modules/google-sheet-products-for-shop/lib/db'
import { createWorkbook } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Creates the workbook (this module always creates its own file - that is what
// keeps us on the non-sensitive drive.file scope). Idempotent: if one already
// exists we return it rather than orphaning it with a duplicate.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (conn?.spreadsheetId && conn.spreadsheetUrl) {
    return NextResponse.json({ spreadsheetId: conn.spreadsheetId, spreadsheetUrl: conn.spreadsheetUrl, alreadyExisted: true })
  }

  try {
    const { spreadsheetId, spreadsheetUrl } = await createWorkbook('Shop catalogue mirror')
    await setSpreadsheet({ spreadsheetId, spreadsheetUrl })
    return NextResponse.json({ spreadsheetId, spreadsheetUrl, alreadyExisted: false })
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    console.error('[google-sheet-products-for-shop/sheet] create failed:', err instanceof Error ? err.message : 'Unknown error')
    return errorResponse('Could not create the Google Sheet. Please try again.', 502)
  }
}
