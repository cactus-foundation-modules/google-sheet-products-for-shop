import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { setSpreadsheet, setVariationTabManifest } from '@/modules/google-sheet-products-for-shop/lib/db'
import { createWorkbook } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { getLatestUnfinishedPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { getRunningPreviewJob } from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Reset: build a fresh, clean workbook and point at it - for when the owner has
// mangled the header beyond repair. We deliberately do NOT delete the old sheet
// from their Drive (no destructive delete from code); it is simply disconnected,
// and they can bin it themselves. A Push refills the new one.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  // Not while something is mid-run. A push part-way through would carry on
  // writing tabs into a workbook nothing is connected to any more, and a pull
  // would read a sheet that has just been swapped out from under it. The settings
  // tab greys the button for the same reason; this is the guard that actually
  // holds, since the tab's view of "busy" is however old its last refresh was.
  const [push, pull, check] = await Promise.all([
    getLatestUnfinishedPushJob(), getLatestUnfinishedPullJob(), getRunningPreviewJob(),
  ])
  if (push || pull || check) {
    return errorResponse(
      `Your sheet is busy - ${push ? 'a push is' : pull ? 'a pull is' : 'a check of the sheet is'} part-way through. Let it finish (or stop it) on the Products page, then reset.`,
      409,
    )
  }

  try {
    const { spreadsheetId, spreadsheetUrl } = await createWorkbook('Shop catalogue mirror')
    await setSpreadsheet({ spreadsheetId, spreadsheetUrl })
    // What the module remembers about the OLD workbook has to go with it. The
    // manifest is the list of product tabs the last Push wrote, and a Pull refuses
    // when one of them is missing - so left in place it describes tabs that were
    // never in this workbook, and the first check of the fresh sheet stops with
    // "these product tabs are missing" about a sheet that is perfectly fine.
    // (Checks pin themselves to the sheet they read by its Drive timestamp, so a
    // finished one cannot be adopted against this new workbook either.)
    await setVariationTabManifest([])
    return NextResponse.json({ spreadsheetId, spreadsheetUrl })
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    console.error('[google-sheet-products-for-shop/reset] failed:', err instanceof Error ? err.message : 'Unknown error')
    return errorResponse('Could not create a fresh Google Sheet. Please try again.', 502)
  }
}
