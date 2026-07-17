import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createImportJob, markImportJobStarted, getImportJobById } from '@/modules/shop/lib/db/import-jobs'
import { processImportJob } from '@/modules/shop/lib/import-engine'
import { getConnection, stampLastPull } from '@/modules/google-sheet-products-for-shop/lib/db'
import { readGrid } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { gridToImportCsv, missingProductsColumns, extractSheetSkus } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { applyStatusPass } from '@/modules/google-sheet-products-for-shop/lib/status-pass'
import { applyArchivePass } from '@/modules/google-sheet-products-for-shop/lib/archive-pass'
import { pullVariations } from '@/modules/google-sheet-products-for-shop/lib/pull-variations'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

const Body = z.object({ archiveSkus: z.array(z.string()).optional() })

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse('Invalid input')
  const archiveSkus = parsed.data.archiveSkus ?? []

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
  const { id: jobId } = await createImportJob({ filename: 'Google Sheet pull', totalRows: dataRows, createdBy: user.id, columnMap: null })
  await markImportJobStarted(jobId)

  // Heavy work in the background, same as shop's own import route. The products
  // import job row is what the admin UI polls; the extra passes finish after it.
  after(async () => {
    const runBy = user.id
    try {
      // 1. Products (create + update), through shop's own engine unchanged.
      await processImportJob(jobId, gridToImportCsv(productsGrid), user.email, null)
      const job = await getImportJobById(jobId)

      // 2. Status pass - the engine ignores the status column; we apply it.
      const status = await applyStatusPass(productsGrid)

      // 3. Archive pass - only the skus the admin explicitly ticked.
      const sheetSkus = extractSheetSkus(productsGrid)
      const archive = await applyArchivePass({ archiveSkus, sheetSkus })

      const productErrors: SyncRowError[] = [...(job?.errors ?? []), ...status.errors, ...archive.errors]
      await writeSyncLog({
        direction: 'PULL', tab: 'PRODUCTS', status: 'COMPLETED',
        createdCount: job?.createdCount ?? 0,
        updatedCount: (job?.updatedCount ?? 0) + status.updated,
        skippedCount: job?.skippedCount ?? 0,
        archivedCount: archive.archived,
        errors: productErrors, runBy,
      })

      // 4. Variations - parents now exist, so this can create/match them.
      const variations = await pullVariations(variationsGrid)
      await writeSyncLog({
        direction: 'PULL', tab: 'VARIATIONS', status: 'COMPLETED',
        createdCount: variations.created, updatedCount: variations.updated,
        errors: variations.errors, runBy,
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
