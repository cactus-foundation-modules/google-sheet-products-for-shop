import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection, stampLastPush } from '@/modules/google-sheet-products-for-shop/lib/db'
import { pushProductsTab } from '@/modules/google-sheet-products-for-shop/lib/push-products'
import { pushVariationsTab } from '@/modules/google-sheet-products-for-shop/lib/push-variations'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Push overwrites the sheet with the database. Products are written before
// Variations - the same order both directions (Variations references product
// slugs). Runs synchronously: a push is a handful of batched writes, and the
// owner wants the "done" before they switch to the sheet.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  try {
    const products = await pushProductsTab(conn.spreadsheetId, conn.includeCostPrice)
    const variations = await pushVariationsTab(conn.spreadsheetId)
    await stampLastPush()

    await writeSyncLog({ direction: 'PUSH', tab: 'PRODUCTS', status: 'COMPLETED', updatedCount: products.rowCount, runBy: user.id })
    await writeSyncLog({ direction: 'PUSH', tab: 'VARIATIONS', status: 'COMPLETED', updatedCount: variations.rowCount, runBy: user.id })

    return NextResponse.json({ ok: true, products: products.rowCount, variations: variations.rowCount })
  } catch (err) {
    const message = err instanceof GoogleAuthError ? err.message : 'The push to Google Sheets failed. Please try again.'
    if (!(err instanceof GoogleAuthError)) {
      console.error('[google-sheet-products-for-shop/push] failed:', err instanceof Error ? err.message : 'Unknown error')
    }
    await writeSyncLog({ direction: 'PUSH', tab: 'PRODUCTS', status: 'FAILED', errors: [{ row: 0, reason: message }], runBy: user.id })
    return errorResponse(message, err instanceof GoogleAuthError ? 400 : 502)
  }
}
