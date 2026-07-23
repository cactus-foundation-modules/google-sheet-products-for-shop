import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createImportJob, markImportJobStarted } from '@/modules/shop/lib/db/import-jobs'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { readGrid, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { missingProductsColumns } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { diffProductRows, diffVariationRows, filterGridByDiff } from '@/modules/google-sheet-products-for-shop/lib/pull-diff'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { createPullJob, getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import type { PullDetected } from '@/modules/google-sheet-products-for-shop/lib/types'

// Start a Pull. A Pull is a resumable job the browser drives step by step (see
// lib/pull-run.ts): this route reads the sheet, diffs it against the shop, and
// creates the job row - the heavy work happens in /pull/step calls.
//
// The diff-at-start is what makes a no-change Pull quick: rows proved identical
// to the shop never reach the importers at all, so the job only carries (and the
// steps only process) rows that create, change, or error. The deletion side is
// planned here from the FULL grids - the filtered ones would read every skipped
// row as "gone from the sheet" - and stored on the job for the DELETIONS phase
// to apply verbatim.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Only one Pull at a time. If an earlier one is paused or failed mid-run, the
  // owner must Continue or cancel it rather than start a second that races it.
  const existing = await getLatestUnfinishedPullJob()
  if (existing) {
    return NextResponse.json(
      { error: 'A pull is already in progress. Continue or cancel it first.', pullJobId: existing.id },
      { status: 409 },
    )
  }

  // Read both tabs up front so an auth failure or a mangled header is reported
  // synchronously, before we create any job or touch the database.
  let productsGrid: string[][]
  let variationsGrid: string[][]
  try {
    productsGrid = await readGrid(conn.spreadsheetId, TAB.PRODUCTS)
    variationsGrid = await readGrid(conn.spreadsheetId, TAB.VARIATIONS)
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    const reason = sheetFailureReason(err)
    console.error('[google-sheet-products-for-shop/pull] read failed:', reason)
    return errorResponse(`Could not read the Google Sheet. ${reason}`, 502)
  }

  const missing = missingProductsColumns(productsGrid)
  if (missing.length) {
    return errorResponse(`Your sheet's Products tab is missing these columns: ${missing.join(', ')}. Fix the header row (or reset the sheet) and try again.`, 400)
  }

  // Diff and plan against the FULL snapshot, then keep only the rows with work
  // in them. Failures here mean the comparison fell over, not the sheet - say so.
  let filteredProducts: string[][]
  let filteredVariations: string[][]
  let detected: PullDetected
  let plan: Awaited<ReturnType<typeof planPullDeletions>>
  try {
    const prodResults = await diffProductRows(productsGrid)
    const varResults = await diffVariationRows(variationsGrid)
    plan = await planPullDeletions(productsGrid, variationsGrid, conn.lastPushAt)
    filteredProducts = filterGridByDiff(productsGrid, prodResults)
    filteredVariations = filterGridByDiff(variationsGrid, varResults)
    // The headline counts, computed here from the same diff that filtered the
    // grids - never taken from the browser, so the dialog cannot be spoofed or
    // simply stale by the time the owner presses Pull.
    detected = {
      productsCreate: prodResults.filter((r) => r.kind === 'create').length,
      productsUpdate: prodResults.filter((r) => r.kind === 'update').length,
      productsDelete: plan.products.length,
      variationsCreate: varResults.filter((r) => r.kind === 'create').length,
      variationsUpdate: varResults.filter((r) => r.kind === 'update').length,
      variationsDelete: plan.variations.length,
      productsUnchanged: prodResults.filter((r) => r.kind === 'unchanged').length,
      variationsUnchanged: varResults.filter((r) => r.kind === 'unchanged').length,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error'
    console.error('[google-sheet-products-for-shop/pull] diff failed:', reason)
    return errorResponse(`Read the sheet fine, but comparing it with your catalogue failed: ${reason}`, 500)
  }

  const productsTotal = Math.max(filteredProducts.length - 1, 0)
  const variationsTotal = Math.max(filteredVariations.length - 1, 0)

  // The shop import job carries the products phase and its live per-row progress.
  const { id: shopImportJobId } = await createImportJob({ filename: 'Google Sheet pull', totalRows: productsTotal, createdBy: user.id, columnMap: null })
  await markImportJobStarted(shopImportJobId)

  const { id: pullJobId } = await createPullJob({
    productsGrid: filteredProducts,
    variationsGrid: filteredVariations,
    deletionPlan: plan,
    lastPushAt: conn.lastPushAt,
    shopImportJobId,
    detected,
    productsTotal, variationsTotal,
    runBy: user.id,
  })

  return NextResponse.json({ pullJobId, productsTotal, variationsTotal, detected }, { status: 202 })
}
