import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection, stampLastPush, stampLastPushAttempt, claimPushLock, releasePushLock } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
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

// How long one Push holds the mutex before another may take over. Well over any
// real push (a handful of batched writes) so the lease only ever expires on a
// push the platform has already killed.
const PUSH_LOCK_MS = 120_000

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

  // Refuse to push over the top of a Pull that is applying the sheet to the shop:
  // a push would rewrite the very sheet being read and move the deletion baseline.
  const pull = await getLatestUnfinishedPullJob()
  if (pull) {
    return errorResponse('A pull from the sheet is in progress. Finish or cancel it before pushing.', 409)
  }

  // Push mutex: two overlapping pushes (a double-submit) would interleave their
  // read/write/clear/restore steps and could corrupt a tab. The loser is asked to
  // retry rather than allowed to race.
  if (!(await claimPushLock(PUSH_LOCK_MS))) {
    return errorResponse('Another push is already running. Give it a moment and try again.', 409)
  }

  try {
    // Unless the owner has already confirmed, refuse to overwrite a sheet that has
    // been edited since Cactus last synced it - those edits would be lost silently.
    const body = await req.json().catch(() => ({}))
    const force = body && typeof body === 'object' && body.force === true
    if (!force) {
      const modifiedAt = await getSheetModifiedTime(conn.spreadsheetId)
      // last_push_attempt_at is included so a previous half-failed push (Products
      // written, Variations threw) is not read back as an owner edit on the retry.
      const syncedAtMs = Math.max(
        conn.lastPushAt?.getTime() ?? 0,
        conn.lastPullAt?.getTime() ?? 0,
        conn.lastPushAttemptAt?.getTime() ?? 0,
      )
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
      // Stamp the edit-guard timestamp after each tab, so a failure partway
      // through does not leave our own writes looking like an owner edit.
      const products = await pushProductsTab(conn.spreadsheetId)
      await stampLastPushAttempt()
      const variations = await pushVariationsTab(conn.spreadsheetId)
      await stampLastPushAttempt()
      // Reference tab, written last: it is nobody's dependency, so a failure here
      // cannot leave the two catalogue tabs half-synced.
      const suppliers = await pushSuppliersTab(conn.spreadsheetId)
      await stampLastPushAttempt()
      // Deletion baseline: stamped only on full success.
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
  } finally {
    await releasePushLock()
  }
}
