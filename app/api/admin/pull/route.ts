import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createImportJob, markImportJobStarted, getImportJobById } from '@/modules/shop/lib/db/import-jobs'
import { processImportJob } from '@/modules/shop/lib/import-engine'
import { getConnection, stampLastPull } from '@/modules/google-sheet-products-for-shop/lib/db'
import { readGrid } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { gridToImportCsv, missingProductsColumns } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { applyStatusPass } from '@/modules/google-sheet-products-for-shop/lib/status-pass'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { applyProductDeletions, applyVariationDeletions } from '@/modules/google-sheet-products-for-shop/lib/delete-pass'
import { pullVariations } from '@/modules/google-sheet-products-for-shop/lib/pull-variations'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Read both tabs up front so an auth failure or a mangled header is reported
  // synchronously, before we spawn any background work or touch the database.
  let productsGrid: string[][]
  let variationsGrid: string[][]
  try {
    productsGrid = await readGrid(conn.spreadsheetId, TAB.PRODUCTS)
    variationsGrid = await readGrid(conn.spreadsheetId, TAB.VARIATIONS)
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    console.error('[google-sheet-products-for-shop/pull] read failed:', err instanceof Error ? err.message : 'Unknown error')
    return errorResponse('Could not read the Google Sheet. Please try again.', 502)
  }

  const missing = missingProductsColumns(productsGrid)
  if (missing.length) {
    return errorResponse(`Your sheet's Products tab is missing these columns: ${missing.join(', ')}. Fix the header row (or reset the sheet) and try again.`, 400)
  }

  const dataRows = Math.max(productsGrid.length - 1, 0)
  const lastPushAt = conn.lastPushAt
  const { id: jobId } = await createImportJob({ filename: 'Google Sheet pull', totalRows: dataRows, createdBy: user.id, columnMap: null })
  await markImportJobStarted(jobId)

  // Heavy work in the background, same as shop's own import route. The products
  // import job row is what the admin UI polls; the extra passes finish after it.
  after(async () => {
    const runBy = user.id
    try {
      // 1. Products (create + update), through shop's own engine. notify:false so
      // the Pull doesn't fire shop's import-complete email on every run - the sync
      // log is where a Pull reports its result, not the inbox.
      await processImportJob(jobId, gridToImportCsv(productsGrid), user.email, null, { notify: false })
      const job = await getImportJobById(jobId)

      // 2. Status pass - the engine ignores the status column; we apply it.
      const status = await applyStatusPass(productsGrid)

      // 3. Plan every deletion once (products + variations), with the push-baseline
      // anchor. Runs after the import so sheet-created products already count as
      // present. Nothing is deleted that was not in the sheet as of the last push.
      const plan = await planPullDeletions(productsGrid, variationsGrid, lastPushAt)

      // 4. Delete products the sheet dropped (cascades their variants).
      const productDeletions = await applyProductDeletions(plan.products)

      const productErrors: SyncRowError[] = [...(job?.errors ?? []), ...status.errors, ...productDeletions.errors]
      await writeSyncLog({
        direction: 'PULL', tab: 'PRODUCTS', status: 'COMPLETED',
        createdCount: job?.createdCount ?? 0,
        updatedCount: (job?.updatedCount ?? 0) + status.updated,
        skippedCount: job?.skippedCount ?? 0,
        archivedCount: productDeletions.deleted,
        errors: productErrors, runBy,
      })

      // 5. Prune the variants the sheet no longer lists FIRST, before the heavy
      // create/match import below. The prune is a single bulk delete; the import
      // walks every sheet row and, on a big catalogue, can run right up against the
      // module dispatcher's time budget. Deleting first means the removal the admin
      // confirmed always lands even if the import afterwards runs out of time - the
      // old order left the delete stranded behind the import and it never ran. (A
      // deleted variation row IS a delete; clearing a parent's whole block removes
      // all of its variants.)
      const variationDeletions = await applyVariationDeletions(plan.variations)
      // 6. Variations create/match - surviving parents now exist, so upsert them.
      const variations = await pullVariations(variationsGrid)
      await writeSyncLog({
        direction: 'PULL', tab: 'VARIATIONS', status: 'COMPLETED',
        createdCount: variations.created, updatedCount: variations.updated,
        archivedCount: variationDeletions.deleted,
        errors: [...variations.errors, ...variationDeletions.errors], runBy,
      })

      await stampLastPull()
    } catch (err) {
      console.error('[google-sheet-products-for-shop/pull] background run failed:', err instanceof Error ? err.message : 'Unknown error')
      await writeSyncLog({
        direction: 'PULL', tab: 'PRODUCTS', status: 'FAILED',
        errors: [{ row: 0, reason: err instanceof Error ? err.message : 'Unknown error' }], runBy,
      })
    }
  })

  return NextResponse.json({ jobId }, { status: 202 })
}
