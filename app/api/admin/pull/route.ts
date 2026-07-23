import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createImportJob, markImportJobStarted } from '@/modules/shop/lib/db/import-jobs'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { readGrid, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { missingProductsColumns } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { createPullJob, getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import type { PullDetected } from '@/modules/google-sheet-products-for-shop/lib/types'

// Start a Pull. A Pull is now a resumable job the browser drives step by step
// (see lib/pull-run.ts): this route only reads the sheet, validates it, and
// creates the job row - the heavy work happens in /pull/step calls. That removes
// the old 60s-in-one-request ceiling that stranded a big catalogue mid-variations.
export async function POST(req: NextRequest) {
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

  const productsTotal = Math.max(productsGrid.length - 1, 0)
  const variationsTotal = Math.max(variationsGrid.length - 1, 0)

  // The confirm dialog's headline counts, carried through for display only.
  const body = await req.json().catch(() => ({}))
  const detected: PullDetected | null =
    body && typeof body === 'object' && body.detected && typeof body.detected === 'object'
      ? {
          productsCreate: Number(body.detected.productsCreate) || 0,
          productsUpdate: Number(body.detected.productsUpdate) || 0,
          productsDelete: Number(body.detected.productsDelete) || 0,
          variationsCreate: Number(body.detected.variationsCreate) || 0,
          variationsUpdate: Number(body.detected.variationsUpdate) || 0,
          variationsDelete: Number(body.detected.variationsDelete) || 0,
        }
      : null

  // The shop import job carries the products phase and its live per-row progress.
  const { id: shopImportJobId } = await createImportJob({ filename: 'Google Sheet pull', totalRows: productsTotal, createdBy: user.id, columnMap: null })
  await markImportJobStarted(shopImportJobId)

  const { id: pullJobId } = await createPullJob({
    productsGrid, variationsGrid,
    lastPushAt: conn.lastPushAt,
    shopImportJobId,
    detected,
    productsTotal, variationsTotal,
    runBy: user.id,
  })

  return NextResponse.json({ pullJobId, productsTotal, variationsTotal }, { status: 202 })
}
