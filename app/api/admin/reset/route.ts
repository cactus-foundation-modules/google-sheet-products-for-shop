import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { setSpreadsheet } from '@/modules/google-sheet-products-for-shop/lib/db'
import { createWorkbook } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Reset: build a fresh, clean workbook and point at it - for when the owner has
// mangled the header beyond repair. We deliberately do NOT delete the old sheet
// from their Drive (no destructive delete from code); it is simply disconnected,
// and they can bin it themselves. A Push refills the new one.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  try {
    const { spreadsheetId, spreadsheetUrl } = await createWorkbook('Shop catalogue mirror')
    await setSpreadsheet({ spreadsheetId, spreadsheetUrl })
    return NextResponse.json({ spreadsheetId, spreadsheetUrl })
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    console.error('[google-sheet-products-for-shop/reset] failed:', err instanceof Error ? err.message : 'Unknown error')
    return errorResponse('Could not create a fresh Google Sheet. Please try again.', 502)
  }
}
