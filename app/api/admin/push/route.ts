import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection, stampLastPush } from '@/modules/google-sheet-products-for-shop/lib/db'
import { pushProductsTab } from '@/modules/google-sheet-products-for-shop/lib/push-products'
import { pushVariationsTab } from '@/modules/google-sheet-products-for-shop/lib/push-variations'
import { pushSuppliersTab } from '@/modules/google-sheet-products-for-shop/lib/push-supplier-catalogues'
import { getSheetModifiedTime, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// A push writes AFTER Cactus stamps last_push_at / a pull stamps last_pull_at, so
// the app's own syncs leave the sheet's modifiedTime at or before the newer stamp.
// This margin only absorbs clock skew between Google's timestamp and the database
// clock; a real edit the owner would mind losing lands minutes or hours after a
// sync, well beyond it. Kept generous so the guard warns on genuine edits, not on
// skew - a false warning is a needless confirm, a missed one silently loses work.
const SYNC_SKEW_MS = 120_000

// Push overwrites the sheet with the database. Products are written before
// Variations - the same order both directions (Variations references product
// slugs). Runs synchronously: a push is a handful of batched writes, and the
// owner wants the "done" before they switch to the sheet.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Unless the owner has already confirmed, refuse to overwrite a sheet that has
  // been edited since Cactus last synced it - those edits would be lost silently.
  const body = await req.json().catch(() => ({}))
  const force = body && typeof body === 'object' && body.force === true
  if (!force) {
    const modifiedAt = await getSheetModifiedTime(conn.spreadsheetId)
    const syncedAtMs = Math.max(conn.lastPushAt?.getTime() ?? 0, conn.lastPullAt?.getTime() ?? 0)
    // Only warn when we have both a modified time and a prior sync to compare it
    // to; a never-synced sheet (or Drive withholding the time) just pushes.
    if (modifiedAt && syncedAtMs > 0 && modifiedAt.getTime() > syncedAtMs + SYNC_SKEW_MS) {
      return NextResponse.json(
        {
          error: 'The sheet has been edited since Cactus last synced it. Pushing now overwrites those edits with the current catalogue.',
          needsConfirm: true,
          modifiedAt: modifiedAt.toISOString(),
        },
        { status: 409 },
      )
    }
  }

  try {
    const products = await pushProductsTab(conn.spreadsheetId)
    const variations = await pushVariationsTab(conn.spreadsheetId)
    // Reference tab, written last: it is nobody's dependency, so a failure here
    // cannot leave the two catalogue tabs half-synced.
    const suppliers = await pushSuppliersTab(conn.spreadsheetId)
    await stampLastPush()

    await writeSyncLog({ direction: 'PUSH', tab: 'PRODUCTS', status: 'COMPLETED', updatedCount: products.rowCount, runBy: user.id })
    await writeSyncLog({ direction: 'PUSH', tab: 'VARIATIONS', status: 'COMPLETED', updatedCount: variations.rowCount, runBy: user.id })

    return NextResponse.json({
      ok: true,
      products: products.rowCount,
      variations: variations.rowCount,
      suppliers: suppliers.rowCount,
      // Formulas the owner had typed into catalogue cells that still agree with
      // the database, and so were written back rather than flattened to values.
      formulasKept: products.preservedFormulas + variations.preservedFormulas,
    })
  } catch (err) {
    const message = err instanceof GoogleAuthError ? err.message : `The push to Google Sheets failed. ${sheetFailureReason(err)}`
    if (!(err instanceof GoogleAuthError)) {
      console.error('[google-sheet-products-for-shop/push] failed:', sheetFailureReason(err))
    }
    await writeSyncLog({ direction: 'PUSH', tab: 'PRODUCTS', status: 'FAILED', errors: [{ row: 0, reason: message }], runBy: user.id })
    return errorResponse(message, err instanceof GoogleAuthError ? 400 : 502)
  }
}
