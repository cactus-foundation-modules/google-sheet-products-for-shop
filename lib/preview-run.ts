import { prisma } from '@/lib/db/prisma'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import {
  getSheetIds, getSheetModifiedTime, readGrid, readHeaderRows, readGridsBatch, sheetFailureReason, SheetsApiError,
} from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import { batchGetGroups } from '@/modules/google-sheet-products-for-shop/lib/batch-ranges'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import {
  RESERVED_TAB_TITLES, isVariationTab, mergeVariationTabs, slugsInMergedGrid, missingManifestSlugs,
} from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'
import { missingProductsColumns } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { columnPrefsFrom, excludedProductColumns } from '@/modules/google-sheet-products-for-shop/lib/columns'
import {
  prepareProductDiff, diffProductRowRange, prepareVariationDiff, diffVariationGroupRange, keptRowsFromResults,
} from '@/modules/google-sheet-products-for-shop/lib/pull-diff'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { getProductIdsWithVariations } from '@/modules/shop-variations/lib/db/variants'
import {
  getPreviewJob, getPreviewJobStatus, updatePreviewJob, claimPreviewStepLease, releasePreviewStepLease,
} from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import type {
  PreviewJob, PreviewStatus, PullPreview, PullDetected, SyncRowError,
} from '@/modules/google-sheet-products-for-shop/lib/types'

// The Pull preview, run as a resumable job (see migrations/012_preview_job.sql).
//
// Nothing here writes to the catalogue. What it does is exactly what the old
// one-shot POST /pull/preview did - read the sheet, compare it with the shop,
// work out what a Pull would create, change and remove - but a bounded slice at a
// time, banking a cursor after each one, so a big catalogue reports progress
// instead of sitting on a loading line until the platform kills it.
//
// The finished job carries the filtered grids, the row maps and the deletion
// plan, so POST /pull adopts them rather than doing the whole sweep again.

// How long one step keeps starting new chunks. Well under the module
// dispatcher's 60s ceiling so the slowest single chunk still finishes and banks
// its cursor before the platform kills the request. Same figure as Pull and Push.
const STEP_TIME_BUDGET_MS = 30_000

// How long a claimed step lease lasts before another worker may take over.
const STEP_LEASE_MS = 90_000

// Products rows compared between cursor writes. The comparison itself is in
// memory; this is only how often the bar moves and how much a killed step redoes.
const PRODUCT_ROW_CHUNK = 50

// Parent products compared between cursor writes. Each one loads its
// contributing modules' state, so the chunk is smaller than the products one.
const PARENT_CHUNK = 12

// Shortest gap between two writes of the HEAVY columns - the tabs read so far,
// the filtered grids, the row maps. Those grow as the check runs, so rewriting
// the whole accumulated blob after every chunk writes a catalogue-wide change to
// the database a few dozen times over, most of it the same bytes again. Banked on
// this clock instead, and always when a phase finishes, so the cost is a handful
// of writes per step however big the catalogue is. The light columns (the name
// being compared) still write every chunk, so the dialog keeps moving.
//
// The cursor is banked in the SAME write as the data it accounts for, never
// separately: a step killed between two banks simply redoes the chunks since the
// last one, which costs a few seconds and is read-only anyway.
const BANK_INTERVAL_MS = 5_000

// How many entries any one list in the preview keeps. The dialog shows the first
// couple of dozen and a "…and N more"; a catalogue-wide edit would otherwise put
// tens of thousands of rows in the job and again in the response. The `…Total`
// beside each list is always the true figure.
export const PREVIEW_LIST_CAP = 200

// A failure that will never clear by being tried again: a tab renamed since the
// last Push, a workbook with no product tabs in it at all. The browser retries a
// failed step five times before it gives up, which for a settled answer like
// these is half a minute of the owner watching nothing happen before they get to
// read what to do. Flagged on the job, the retry loop stops at once.
class SettledError extends Error {}

// Will trying this again ever help?
//
//   - Our own guards (SettledError) and a refused connection: no.
//   - Google saying 4xx about the request itself - a range it cannot parse
//     because a tab has been renamed or deleted, a spreadsheet that is gone: no
//     either, and these are the ones an owner most needs telling about. They used
//     to be retried five times with backoff first, so the sentence explaining what
//     to fix arrived half a minute after the answer was known.
//   - 429 (Google's rate limit) and 5xx: yes, always - those clear on their own,
//     which is the whole point of the retry loop.
function isSettled(err: unknown): boolean {
  if (err instanceof SettledError || err instanceof GoogleAuthError) return true
  return err instanceof SheetsApiError && err.status >= 400 && err.status < 500 && err.status !== 429
}

function emptyPreview(): PullPreview {
  return {
    products: {
      toCreate: [], toCreateTotal: 0, toUpdate: [], toUpdateTotal: 0, toDelete: [], toDeleteTotal: 0,
      unchanged: 0, rowErrors: [], rowErrorsTotal: 0,
    },
    variations: {
      toCreate: 0, toUpdate: [], toUpdateTotal: 0, toDelete: [], toDeleteTotal: 0,
      unchanged: 0, rowErrors: [], rowErrorsTotal: 0,
    },
    staleness: { changedSinceLastPush: 0, since: null },
    headerMissing: [],
  }
}

// Append to a capped list. The array stops growing at the cap; the caller keeps
// the true count separately.
function capPush<T>(list: T[], items: T[]): void {
  for (const item of items) {
    if (list.length >= PREVIEW_LIST_CAP) return
    list.push(item)
  }
}

export function previewStatus(job: PreviewJob): PreviewStatus {
  return {
    previewJobId: job.id,
    status: job.status,
    phase: job.phase,
    done: job.status === 'COMPLETED',
    tabsTotal: job.tabsTotal,
    tabsDone: job.tabsDone,
    productsTotal: job.productsTotal,
    productsDone: job.productsDone,
    variationsTotal: job.variationsTotal,
    variationsDone: job.variationsDone,
    currentItem: job.status === 'RUNNING' ? job.currentItem : null,
    error: job.error,
    fatal: job.fatal,
    // Only a finished check has a preview worth showing: half a diff would put
    // counts on screen that are simply wrong.
    preview: job.status === 'COMPLETED' ? job.preview : null,
  }
}

// The headline counts, derived from the finished preview so the confirm dialog
// and the Pull it starts can never disagree.
function detectedFrom(preview: PullPreview): PullDetected {
  return {
    productsCreate: preview.products.toCreateTotal,
    productsUpdate: preview.products.toUpdateTotal,
    productsDelete: preview.products.toDeleteTotal,
    variationsCreate: preview.variations.toCreate,
    variationsUpdate: preview.variations.toUpdateTotal,
    variationsDelete: preview.variations.toDeleteTotal,
    productsUnchanged: preview.products.unchanged,
    variationsUnchanged: preview.variations.unchanged,
  }
}

// --- READ -------------------------------------------------------------------

// First slice of the READ phase: the sheet's modified time, the Products tab, and
// the list of tabs that might be product tabs. Three Google calls, so it always
// fits a step and the dialog gets its first real numbers straight away.
async function readOpening(job: PreviewJob, spreadsheetId: string): Promise<void> {
  // modifiedTime is fetched BEFORE the grids: if the sheet is edited while they
  // are being read, the stored time predates the edit, the Pull's own fetch sees
  // a later instant, and the (possibly torn) snapshot is simply not reused.
  const modifiedAt = await getSheetModifiedTime(spreadsheetId)
  const [productsGrid, ids] = await Promise.all([
    readGrid(spreadsheetId, TAB.PRODUCTS),
    getSheetIds(spreadsheetId),
  ])
  const candidates = Object.keys(ids).filter((t) => !RESERVED_TAB_TITLES.has(t))
  await updatePreviewJob(job.id, {
    driveModifiedTime: modifiedAt,
    productsGrid,
    tabTitles: candidates,
    tabsTotal: candidates.length,
    tabsDone: 0,
    rawTabs: [],
    currentItem: null,
  })
}

// One group of candidate tabs: read their header rows (one call), then the full
// body of just the ones that proved to be product tabs (one more). Reading only a
// header for the owner's own tabs is what keeps a big notes tab from being
// downloaded on every check.
async function readTabGroup(spreadsheetId: string, group: string[]): Promise<string[][][]> {
  const headers = await readHeaderRows(spreadsheetId, group)
  const variationTabs = group.filter((t) => isVariationTab(t, headers[t] ?? []))
  if (variationTabs.length === 0) return []
  const grids = await readGridsBatch(spreadsheetId, variationTabs)
  return variationTabs.map((t) => grids[t] ?? [])
}

// Everything the READ phase does once the last tab is in: merge the product tabs
// into the one wide grid the rest of the pipeline works off, keep the snapshot
// for the Pull to reuse, and run the two guards that stop a Pull reading a
// missing tab as "these variants are gone".
async function finishRead(job: PreviewJob, productsGrid: string[][], rawTabs: string[][][]): Promise<void> {
  const conn = await getConnection()
  const variationsGrid = rawTabs.length > 0 ? mergeVariationTabs(rawTabs) : []

  // The two guards run BEFORE anything is stored: neither will ever pass by being
  // tried again, so they must not sit behind a several-megabyte snapshot write
  // that would then be repeated on each retry.
  const manifest = conn?.variationTabManifest ?? []
  if (manifest.length > 0) {
    const present = slugsInMergedGrid(variationsGrid)
    const missingSlugs = missingManifestSlugs(manifest.map((m) => m.slug), present)
    if (missingSlugs.length > 0) {
      const titles = manifest.filter((m) => missingSlugs.includes(m.slug)).map((m) => `"${m.title}"`)
      throw new SettledError(
        `These product tabs are missing from your sheet: ${titles.join(', ')}. A tab has been renamed, deleted or emptied since your last Push. Restore it (or Push again) before pulling.`,
      )
    }
  } else if (variationsGrid.length === 0) {
    // No manifest and no product tabs at all: if the shop still has variants,
    // pulling would read them as "all removed". Say so now rather than at Pull.
    const withVariants = await getProductIdsWithVariations()
    if (withVariants.length > 0) {
      throw new SettledError(
        'Your sheet has no product variation tabs, so a Pull cannot tell which variations you still have and would try to delete every one. Push to the sheet first, then pull.',
      )
    }
  }

  // Nothing is copied anywhere: the grids stay on this job's own row, which is
  // what a Pull started from this check adopts. There used to be a second copy
  // written to a table of its own for exactly that purpose - several megabytes on
  // a big catalogue, on every check, read by nothing once the check became a job
  // that keeps its own working (see migrations/015).

  // A column the owner has switched off is absent on purpose, so it is not
  // "missing" - the same rule the Pull itself applies before it will run.
  const headerMissing = missingProductsColumns(productsGrid, excludedProductColumns(columnPrefsFrom(conn ?? null)))
  const preview = { ...emptyPreview(), headerMissing }

  // How many products the admin has changed since the last Push - what a Pull
  // would overwrite. One count, and only when there is a baseline to count from.
  if (conn?.lastPushAt) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "shp_products"
      WHERE "catalogue_hidden" = false AND "updated_at" > ${conn.lastPushAt}
    `
    preview.staleness = { changedSinceLastPush: Number(rows[0]?.count ?? 0), since: conn.lastPushAt.toISOString() }
  }

  await updatePreviewJob(job.id, {
    variationsGrid,
    rawTabs: null,
    preview,
    lastPushAt: conn?.lastPushAt ?? null,
    productsTotal: Math.max(productsGrid.length - 1, 0),
    productsDone: 0,
    filteredProducts: [productsGrid[0] ?? []],
    productsRowMap: [],
    filteredVariations: [variationsGrid[0] ?? []],
    variationsRowMap: [],
    currentItem: null,
    // A mangled header makes every column index meaningless, so there is nothing
    // to compare - the dialog shows which columns to put back instead.
    phase: headerMissing.length > 0 ? 'DONE' : 'PRODUCTS',
  })
}

async function runReadPhase(job: PreviewJob, spreadsheetId: string, startedAt: number): Promise<void> {
  if (!job.productsGrid) {
    await readOpening(job, spreadsheetId)
    return // the next step carries on with the tabs; the dialog gets its totals now
  }
  const titles = job.tabTitles ?? []
  let done = job.tabsDone
  const raw = job.rawTabs ?? []
  let lastBankAt = Date.now()
  while (done < titles.length && Date.now() - startedAt < STEP_TIME_BUDGET_MS) {
    if ((await getPreviewJobStatus(job.id)) === 'CANCELLED') return
    // Group boundaries are decided from the remaining tabs, so they are the same
    // whichever step picks up here - a re-run group is the same group.
    const group = batchGetGroups(titles.slice(done))[0] ?? []
    if (group.length === 0) break
    raw.push(...await readTabGroup(spreadsheetId, group))
    done += group.length
    const currentItem = group[group.length - 1] ?? null
    if (done >= titles.length || Date.now() - lastBankAt >= BANK_INTERVAL_MS) {
      await updatePreviewJob(job.id, { tabsDone: done, rawTabs: raw, status: 'RUNNING', error: null, currentItem })
      lastBankAt = Date.now()
    } else {
      await updatePreviewJob(job.id, { currentItem })
    }
  }
  if (done >= titles.length) await finishRead({ ...job, tabsDone: done }, job.productsGrid, raw)
}

// --- PRODUCTS ---------------------------------------------------------------

async function runProductsPhase(job: PreviewJob, startedAt: number): Promise<void> {
  const grid = job.productsGrid
  if (!grid) throw new Error('The check lost its copy of the Products tab. Start it again.')
  const preview = job.preview ?? emptyPreview()
  const ctx = await prepareProductDiff(grid)

  let cursor = job.productsDone
  const keptRows = [...(job.filteredProducts ?? [grid[0] ?? []])]
  const rowMap = [...(job.productsRowMap ?? [])]
  let currentItem = job.currentItem
  let lastBankAt = Date.now()

  while (cursor < ctx.rowCount && Date.now() - startedAt < STEP_TIME_BUDGET_MS) {
    if ((await getPreviewJobStatus(job.id)) === 'CANCELLED') return
    const from = cursor + 1 // grid row index: data rows start at 1
    const to = Math.min(from + PRODUCT_ROW_CHUNK, grid.length)
    const results = await diffProductRowRange(ctx, from, to, (name) => { currentItem = name || currentItem })

    for (const r of results) {
      if (r.kind === 'error') {
        preview.products.rowErrorsTotal++
        capPush(preview.products.rowErrors, [{ row: r.row + 1, reason: r.reason }])
      } else if (r.kind === 'create') {
        preview.products.toCreateTotal++
        capPush(preview.products.toCreate, [{ sku: r.sku, name: r.name }])
      } else if (r.kind === 'update') {
        preview.products.toUpdateTotal++
        capPush(preview.products.toUpdate, [{ sku: r.sku, name: r.name, changes: r.changes }])
      } else {
        preview.products.unchanged++
      }
    }
    const kept = keptRowsFromResults(grid, results)
    keptRows.push(...kept.rows)
    rowMap.push(...kept.sheetRows)

    cursor = to - 1
    if (cursor >= ctx.rowCount || Date.now() - lastBankAt >= BANK_INTERVAL_MS) {
      await updatePreviewJob(job.id, {
        status: 'RUNNING', error: null, productsDone: cursor, preview,
        filteredProducts: keptRows, productsRowMap: rowMap, currentItem,
      })
      lastBankAt = Date.now()
    } else {
      await updatePreviewJob(job.id, { currentItem })
    }
  }

  // The phase-closing write carries the accumulators too, not just the phase. A
  // Products tab with no data rows at all never enters the loop above, so nothing
  // else would ever write them - and while that is only a header row here, the
  // variations phase has the same shape and real rows to lose (see below).
  if (cursor >= ctx.rowCount) {
    await updatePreviewJob(job.id, {
      phase: 'DELETIONS', status: 'RUNNING', error: null, currentItem: null,
      productsDone: cursor, preview, filteredProducts: keptRows, productsRowMap: rowMap,
    })
  }
}

// --- DELETIONS --------------------------------------------------------------

async function runDeletionsPhase(job: PreviewJob): Promise<void> {
  const productsGrid = job.productsGrid
  const variationsGrid = job.variationsGrid
  if (!productsGrid || !variationsGrid) throw new Error('The check lost its copy of the sheet. Start it again.')
  const preview = job.preview ?? emptyPreview()

  // Both bulk queries: one paged catalogue read and one batched load of every
  // variable parent's variants. Nothing here is per-row, so the phase is a single
  // bounded slice with no cursor of its own.
  const plan = await planPullDeletions(productsGrid, variationsGrid, job.lastPushAt)

  preview.products.toDeleteTotal = plan.products.length
  preview.products.toDelete = []
  capPush(preview.products.toDelete, plan.products)
  preview.variations.toDeleteTotal = plan.variations.length
  preview.variations.toDelete = []
  capPush(preview.variations.toDelete, plan.variations.map((v) => ({
    childProductId: v.childProductId, parentName: v.parentName, label: v.label,
  })))

  await updatePreviewJob(job.id, {
    phase: 'VARIATIONS', status: 'RUNNING', error: null, currentItem: null,
    preview, deletionPlan: plan,
  })
}

// --- VARIATIONS -------------------------------------------------------------

async function runVariationsPhase(job: PreviewJob, startedAt: number): Promise<void> {
  const grid = job.variationsGrid
  if (!grid) throw new Error('The check lost its copy of your product tabs. Start it again.')
  const preview = job.preview ?? emptyPreview()
  const ctx = await prepareVariationDiff(grid)

  let cursor = job.variationsDone
  const keptRows = [...(job.filteredVariations ?? [grid[0] ?? []])]
  const rowMap = [...(job.variationsRowMap ?? [])]
  let currentItem = job.currentItem
  let lastBankAt = Date.now()

  // The rows the grouping itself rejected belong to no parent, so they are
  // recorded once, as the phase starts.
  if (cursor === 0 && ctx.preErrors.length > 0) {
    for (const e of ctx.preErrors) {
      preview.variations.rowErrorsTotal++
      capPush(preview.variations.rowErrors, [{ row: e.row + 1, reason: e.reason ?? 'Invalid row' }])
    }
    const kept = keptRowsFromResults(grid, ctx.preErrors)
    keptRows.push(...kept.rows)
    rowMap.push(...kept.sheetRows)
  }

  if (job.variationsTotal !== ctx.groups.length) {
    await updatePreviewJob(job.id, { variationsTotal: ctx.groups.length })
  }

  while (cursor < ctx.groups.length && Date.now() - startedAt < STEP_TIME_BUDGET_MS) {
    if ((await getPreviewJobStatus(job.id)) === 'CANCELLED') return
    const to = Math.min(cursor + PARENT_CHUNK, ctx.groups.length)
    const results = await diffVariationGroupRange(ctx, cursor, to, (name) => { currentItem = name || currentItem })

    for (const r of results) {
      if (r.kind === 'error') {
        preview.variations.rowErrorsTotal++
        capPush(preview.variations.rowErrors, [{ row: r.row + 1, reason: r.reason ?? 'Invalid row' } as SyncRowError])
      } else if (r.kind === 'create') {
        preview.variations.toCreate++
      } else if (r.kind === 'update') {
        preview.variations.toUpdateTotal++
        capPush(preview.variations.toUpdate, [{
          parentName: r.parentName ?? 'Unknown product',
          label: r.label ?? `row ${r.row + 1}`,
        }])
      } else {
        preview.variations.unchanged++
      }
    }
    // Sheet order across the whole grid is what the Pull's row map assumes, and
    // parents are visited in first-appearance order, so appending each chunk's
    // kept rows keeps the two in step.
    const kept = keptRowsFromResults(grid, results)
    keptRows.push(...kept.rows)
    rowMap.push(...kept.sheetRows)

    cursor = to
    if (cursor >= ctx.groups.length || Date.now() - lastBankAt >= BANK_INTERVAL_MS) {
      await updatePreviewJob(job.id, {
        status: 'RUNNING', error: null, variationsDone: cursor, variationsTotal: ctx.groups.length,
        preview, filteredVariations: keptRows, variationsRowMap: rowMap, currentItem,
      })
      lastBankAt = Date.now()
    } else {
      await updatePreviewJob(job.id, { currentItem })
    }
  }

  // As above, and here it matters: a sheet whose variation rows all failed the
  // grouping - no "Parent Slug" column, or every row missing its slug - has NO
  // parent groups, so the loop never runs. Closing the phase without this write
  // would throw away every one of those row errors and the rows that carry them,
  // and the dialog would report a sheet with nothing wrong with it.
  if (cursor >= ctx.groups.length) {
    await updatePreviewJob(job.id, {
      phase: 'DONE', status: 'RUNNING', error: null, currentItem: null,
      variationsDone: cursor, variationsTotal: ctx.groups.length,
      preview, filteredVariations: keptRows, variationsRowMap: rowMap,
    })
  }
}

// --- the step ---------------------------------------------------------------

// Close the check exactly once: flip to COMPLETED atomically, then drop the
// working grids. Only the worker that wins the flip finalises, so a crash and a
// retry cannot double-count anything.
async function finalisePreviewJob(job: PreviewJob): Promise<void> {
  if (job.status === 'CANCELLED' || (await getPreviewJobStatus(job.id)) === 'CANCELLED') return
  const preview = job.preview ?? emptyPreview()

  // The headline counts are written BEFORE the status flip, not after. The flip
  // is what the dialog watches for, and a Pull pressed in the gap between the two
  // would have found a finished check with no counts on it - which reads as
  // "stale, check again", sending the owner round the loop for no reason. Writing
  // them first is safe to repeat: two workers racing here write the same numbers,
  // and only one of them goes on to win the flip.
  await updatePreviewJob(job.id, { detected: detectedFrom(preview), preview })

  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "gsp_preview_job" SET "status" = 'COMPLETED', "phase" = 'DONE', "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${job.id} AND "status" NOT IN ('COMPLETED', 'CANCELLED')
    RETURNING "id"
  `
  if (claimed.length === 0) return
  // Only the winner drops the working grids - they are what makes this row big,
  // and nothing reads them once the check is done.
  await updatePreviewJob(job.id, { clearWorking: true })
}

async function runPreviewStep(job: PreviewJob): Promise<void> {
  const startedAt = Date.now()
  try {
    const conn = await getConnection()
    if (!conn?.spreadsheetId) throw new Error('The Google Sheet connection is missing its spreadsheet.')

    if (job.phase === 'READ') await runReadPhase(job, conn.spreadsheetId, startedAt)
    else if (job.phase === 'PRODUCTS') await runProductsPhase(job, startedAt)
    else if (job.phase === 'DELETIONS') await runDeletionsPhase(job)
    else if (job.phase === 'VARIATIONS') await runVariationsPhase(job, startedAt)

    const after = await getPreviewJob(job.id)
    if (after && after.phase === 'DONE' && after.status === 'RUNNING') await finalisePreviewJob(after)
  } catch (err) {
    // A failed step leaves every cursor intact and the job FAILED, so Continue
    // retries the same slice once the cause clears. Google's own failures get the
    // plain-English reading; anything else says what it said. A settled answer is
    // flagged so the browser stops asking rather than retrying it five times.
    const reason = err instanceof GoogleAuthError ? err.message : sheetFailureReason(err)
    await updatePreviewJob(job.id, { status: 'FAILED', error: reason, fatal: isSettled(err), currentItem: null })
  }
}

// Run exactly one bounded slice of the check and return the live snapshot. Safe
// to call repeatedly (the browser loops it) and safe to resume: every phase picks
// up from its own cursor and nothing it does is a write to the catalogue.
export async function stepPreviewJob(jobId: string): Promise<PreviewStatus | null> {
  const job = await getPreviewJob(jobId)
  if (!job) return null
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return previewStatus(job)

  const lease = await claimPreviewStepLease(jobId, STEP_LEASE_MS)
  if (lease) {
    try {
      const fresh = await getPreviewJob(jobId)
      if (fresh && fresh.status !== 'COMPLETED' && fresh.status !== 'CANCELLED') await runPreviewStep(fresh)
    } catch (err) {
      // Only the lease machinery's own failures land here - a phase error is
      // caught inside runPreviewStep and recorded on the job. Record this too, so
      // the browser sees a reason and a Continue rather than looping on a stale
      // snapshot for ever.
      // Message only - a database error object can carry the datasource URL.
      const reason = err instanceof Error ? err.message : 'Unknown error'
      console.error('[google-sheet-products-for-shop] preview step failed:', reason)
      await updatePreviewJob(jobId, { status: 'FAILED', error: `The check could not run: ${reason}` }).catch(() => {})
    } finally {
      await releasePreviewStepLease(jobId, lease)
    }
  }

  const after = await getPreviewJob(jobId)
  return after ? previewStatus(after) : null
}
