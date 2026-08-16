import { processImportJob } from '@/modules/shop/lib/import-engine'
import { getImportJobById, updateImportJobProgress } from '@/modules/shop/lib/db/import-jobs'
import { importVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { applyProductFieldsPass } from '@/modules/google-sheet-products-for-shop/lib/product-fields-pass'
import { applyDescriptionPuckPass } from '@/modules/google-sheet-products-for-shop/lib/description-puck-pass'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { applyProductDeletions, applyVariationDeletions } from '@/modules/google-sheet-products-for-shop/lib/delete-pass'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { stampLastPull } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getPullJobLight, getPullJobForStep, getPullJobStatus, updatePullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { prisma } from '@/lib/db/prisma'
import { describeFailure, OwnerMessageError } from '@/modules/google-sheet-products-for-shop/lib/failure'
import type { PullJob, PullJobLight, PullStatus } from '@/modules/google-sheet-products-for-shop/lib/types'

// How many variation rows land in one importer call. Each call carries a fixed
// per-parent cost (load the parent, its variants, their fields, its options and
// images once), so a bigger chunk amortises that over more rows - and a parent
// whose rows straddle a chunk boundary pays that cost twice, so fewer, bigger
// chunks also mean fewer straddles. It stayed at 10 only because every row used
// to re-read its child to check for changes; now that the importer diffs a
// pre-loaded field map in memory and flushes its writes together, 50 rows finish
// comfortably inside the dispatcher's 60s ceiling. The cursor still advances
// after every chunk, so a killed step re-does at most one chunk of idempotent
// no-ops - never the whole batch that once wedged a Pull.
const VAR_ROW_CHUNK = 50

// How many product rows go through shop's import engine per call. Products used
// to run as ONE unbounded call over the whole filtered grid: a big enough
// changed-row count blew the dispatcher's 60s ceiling, the platform killed the
// request before the phase could advance, the next step started the import over,
// and the Pull sat on "Updating products…" forever. Chunked, every chunk banks
// its cursor (products_done) and a step ends at the time budget like variations.
// 40 rather than the original 25: each call re-parses the CSV and re-resolves
// the column map, so fewer, bigger chunks waste less of the budget on setup -
// and chunk size never risks the ceiling, because the step's 35s clock decides
// when to stop starting chunks either way.
const PROD_ROW_CHUNK = 40

// How many products (or variants) are deleted per statement. Each one cascades
// through its media, categories, variants, variant values and every module's
// per-product rows, so this is a chunk of real work rather than a formality -
// small enough that one chunk always finishes inside a step, large enough that a
// big clear-out is not a thousand round trips.
const DELETE_CHUNK = 100

// The platform kills a module route at sixty seconds - a cliff, not a target.
const MODULE_ROUTE_CEILING_MS = 60_000

// How long one /pull/step keeps STARTING new chunks, leaving the rest of the
// ceiling as room for the chunk in flight to finish. Was 35s, which left only 25s
// of headroom: a slow import chunk on top of that is a 504, the browser retries,
// and the owner's site logs a failed request for work that was going fine.
const STEP_TIME_BUDGET_MS = 20_000

// Margin before the platform's ceiling inside which it is not worth STARTING the
// guaranteed chunk. Past this the request is about to be killed, so the chunk
// could not land its cursor anyway - beginning it would burn the work twice over.
const CHUNK_START_MARGIN_MS = 15_000

// A step must normally finish at least ONE chunk, whatever the budget clock says.
// A phase whose setup outgrows the budget would otherwise never enter its loop,
// never move its cursor, and be repeated identically by every step that followed
// - a job that cannot finish rather than one that is merely slow. That is what
// "Products compared - 0 of 445" was.
//
// The one exception is the ceiling: if setup has already eaten so much of the
// sixty seconds that a chunk cannot land, the step gives up cleanly instead of
// being killed mid-chunk. The callers treat "did nothing at all" as an error
// worth showing, so that case surfaces rather than looping in silence.
function mayStartChunk(chunksDone: number, startedAt: number): boolean {
  const elapsed = Date.now() - startedAt
  if (chunksDone === 0) return elapsed < MODULE_ROUTE_CEILING_MS - CHUNK_START_MARGIN_MS
  return elapsed < STEP_TIME_BUDGET_MS
}

// What a phase says when its setup alone has used up the request. Loud on
// purpose: silence here is what a wedged job looks like from the outside.
function setupTooSlow(what: string): Error {
  return new Error(
    `Loading your ${what} took so long that there was no time left to compare anything. ` +
    'This usually clears on its own - if it keeps happening, your catalogue has outgrown what one pass can do.',
  )
}

// How many finished rows the dialog keeps on screen, newest first.
const RECENT_ITEMS = 8

// Smallest gap between two progress writes. Both importers announce every row,
// and a 600-row Pull writing the job row 600 times would spend more time on
// commentary than on work. The browser polls at 1.5s, so anything under that is
// invisible anyway; this just keeps the name moving between polls.
const ROW_REPORT_MS = 600

// Turns the importers' per-row callbacks into the job row's live commentary:
// the item being written, how many rows of the chunk in flight are behind it,
// and the last few finished. None of it is a cursor - see migration 008 for why
// the real cursor may not move mid-chunk - so a dropped write costs nothing but
// a stale line on screen, which is why every write here is best-effort.
function makeRowReporter(jobId: string, initialRecent: string[]) {
  let recent = initialRecent.slice(0, RECENT_ITEMS)
  let current: string | null = null
  let offset = 0
  let lastWriteAt = 0

  async function write(): Promise<void> {
    lastWriteAt = Date.now()
    await updatePullJob(jobId, { currentItem: current, currentOffset: offset, recentItems: recent }).catch(() => {})
  }

  return {
    // Called by the importer as it picks a row up, before that row's writes. The
    // row announced last is the one now finished, so it moves to the recents.
    async onRow(label: string): Promise<void> {
      if (current !== null) {
        recent = [current, ...recent].slice(0, RECENT_ITEMS)
        offset += 1
      }
      current = label.trim() || 'Untitled row'
      if (Date.now() - lastWriteAt >= ROW_REPORT_MS) await write()
    },
    // Chunk boundary: the last announced row has finished too, and the offset
    // resets because the real cursor is about to absorb it. Returns the fields
    // for the same UPDATE that banks the cursor rather than writing its own.
    bank(): { currentItem: null; currentOffset: number; recentItems: string[] } {
      if (current !== null) { recent = [current, ...recent].slice(0, RECENT_ITEMS); current = null }
      offset = 0
      return { currentItem: null, currentOffset: 0, recentItems: recent }
    },
  }
}

// Live products progress is the job's own cursor, written after every chunk -
// no extra read of the shop import job per status poll. Once the products phase
// is behind us, products are simply all done. The in-chunk offset rides on top
// so the bar moves per row rather than in jumps of 25; it is display only and
// never outruns the total.
function productsDoneFor(job: PullJobLight): number {
  return job.phase === 'PRODUCTS' ? Math.min(job.productsDone + job.currentOffset, job.productsTotal) : job.productsTotal
}

function variationsDoneFor(job: PullJobLight): number {
  return job.phase === 'VARIATIONS' ? Math.min(job.variationsDone + job.currentOffset, job.variationsTotal) : job.variationsDone
}

export async function pullStatus(job: PullJobLight): Promise<PullStatus> {
  const productsDone = productsDoneFor(job)
  // The removals stage's own bar. The plan is cleared once the job finishes, so
  // the total comes from the headline counts the check computed - which is the
  // same number, and still there afterwards. A job from before the removals had a
  // cursor reports zero of zero, and simply shows no bar.
  const deletionsTotal = (job.detected?.productsDelete ?? 0) + (job.detected?.variationsDelete ?? 0)
  const deletionsDone = job.phase === 'DELETIONS'
    ? Math.min(job.prodDeletionsDone + job.varDeletionsDone, deletionsTotal)
    : job.phase === 'PRODUCTS' ? 0 : deletionsTotal
  return {
    pullJobId: job.id,
    status: job.status,
    phase: job.phase,
    done: job.status === 'COMPLETED',
    productsTotal: job.productsTotal,
    productsDone,
    variationsTotal: job.variationsTotal,
    variationsDone: variationsDoneFor(job),
    deletionsTotal,
    deletionsDone,
    // A stopped, failed or finished job has nothing in flight - the last name it
    // wrote would otherwise sit there reading as if work were still going on.
    currentItem: job.status === 'RUNNING' ? job.currentItem : null,
    recentItems: job.recentItems ?? [],
    detected: job.detected,
    counts: {
      productsCreated: job.prodCreated,
      productsUpdated: job.prodUpdated,
      productsDeleted: job.prodDeleted,
      variationsCreated: job.varCreated,
      variationsUpdated: job.varUpdated,
      variationsDeleted: job.varDeleted,
    },
    errorCount: (job.prodErrors?.length ?? 0) + (job.varErrors?.length ?? 0),
    error: job.error,
  }
}

// Write the two audit rows, stamp the pull, and close the job. Called once the
// last variation batch lands (or immediately if there were no variation rows).
async function finalizePullJob(job: PullJobLight): Promise<void> {
  // A Stop that lands between the last chunk and here must not produce a
  // "COMPLETED" pair of audit rows for a pull that was abandoned.
  if (job.status === 'CANCELLED' || (await getPullJobStatus(job.id)) === 'CANCELLED') return
  // Claim finalisation exactly once by flipping the status to COMPLETED
  // atomically. Only the worker that wins the flip writes the audit rows, so a
  // crash between the log writes and the close - which used to re-run finalize on
  // the next step and write a second COMPLETED pair - can no longer duplicate
  // them. The grids are cleared after, in a separate write, so a crash there just
  // leaves a finished job carrying its snapshot (harmless) rather than lost logs.
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "gsp_pull_job" SET "status" = 'COMPLETED', "phase" = 'DONE', "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${job.id} AND "status" NOT IN ('COMPLETED', 'CANCELLED')
    RETURNING "id"
  `
  if (claimed.length === 0) return
  // Rows the start-of-pull diff proved identical never reached the importers;
  // they are skips all the same, and the audit log should say so. A run whose
  // rows errored is not a clean success either - logging it as plain COMPLETED
  // hid every SKU-blocked row from the owner, so a tab with errors is recorded
  // as COMPLETED_WITH_ERRORS instead.
  const prodErrors = job.prodErrors ?? []
  const varErrors = job.varErrors ?? []
  await writeSyncLog({
    direction: 'PULL', tab: 'PRODUCTS',
    status: prodErrors.length ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
    createdCount: job.prodCreated, updatedCount: job.prodUpdated,
    skippedCount: job.prodSkipped + (job.detected?.productsUnchanged ?? 0),
    archivedCount: job.prodDeleted, errors: prodErrors, runBy: job.runBy,
  })
  await writeSyncLog({
    direction: 'PULL', tab: 'VARIATIONS',
    status: varErrors.length ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
    createdCount: job.varCreated, updatedCount: job.varUpdated,
    skippedCount: job.detected?.variationsUnchanged ?? 0,
    archivedCount: job.varDeleted, errors: varErrors, runBy: job.runBy,
  })
  await stampLastPull()
  await updatePullJob(job.id, { clearGrids: true })
}

// How long a claimed step lease lasts before another worker may take the job
// over. Longer than any single request can live (the module dispatcher kills a
// route at 60s), so a lease only ever expires on a step that is already dead -
// a live step always finishes and releases well inside it.
const STEP_LEASE_MS = 90_000

// Run `fn` only when no other worker is already stepping this job. Returns
// false, without running `fn`, when another worker holds the lease.
//
// This used to be a transaction-scoped advisory lock (pg_try_advisory_xact_lock)
// held in a prisma.$transaction for the whole step. That self-deadlocks on an
// install whose DATABASE_URL runs through a pooler with connection_limit=1: the
// open transaction owns the pool's ONLY connection, every query inside the step
// runs on the global client and queues for a second one, and after 20 seconds
// Prisma gives up - "Timed out fetching a new connection from the connection
// pool" on every step, surfaced as an endless "Hit a snag - retrying".
//
// The lease is a single atomic UPDATE on the job row instead: claim and release
// each hold a connection only for their own statement, so the step's queries run
// with the pool to themselves. A step the platform kills never reaches the
// release, which is why the claim also accepts an EXPIRED lease - the next
// Continue waits out at most STEP_LEASE_MS, exactly the stranded-lock case the
// old xact lock avoided, priced in rather than avoided because a lease survives
// transaction pooling and a pool of one, which the xact lock did not.
async function withPullStepLock(jobId: string, fn: () => Promise<void>): Promise<boolean> {
  const claimed = await prisma.$queryRaw<Array<{ step_lease_until: Date }>>`
    UPDATE "gsp_pull_job"
    SET "step_lease_until" = now() + (${STEP_LEASE_MS}::int4 * interval '1 millisecond')
    WHERE "id" = ${jobId}
      AND ("step_lease_until" IS NULL OR "step_lease_until" < now())
    RETURNING "step_lease_until"
  `
  const myLease = claimed[0]?.step_lease_until
  if (!myLease) return false
  try {
    await fn()
  } finally {
    // Best-effort, and scoped to OUR lease: if this step outlived STEP_LEASE_MS
    // (impossible under Vercel's 60s kill, possible self-hosted/local) another
    // worker may already hold a fresh lease, and an unconditional clear would
    // wipe it. Releasing only when the stored expiry is still ours leaves that
    // other worker's lease intact. Never let a failed release mask a step error.
    await prisma
      .$executeRaw`UPDATE "gsp_pull_job" SET "step_lease_until" = NULL WHERE "id" = ${jobId} AND "step_lease_until" = ${myLease}`
      .catch(() => {})
  }
  return true
}

// Reorder the filtered variation data rows so every row of a parent is
// contiguous, in first-appearance order, and report where each parent group
// starts. Slugless rows stay as their own singleton groups (the importer errors
// on them either way). `sheetRows` carries each row's original sheet row number
// so error reporting survives the reorder; it defaults to the header-offset index.
function groupVariationRowsByParent(
  header: string[],
  dataRows: string[][],
  sheetRows: number[] | null,
): { orderedRows: string[][]; orderedSheetRows: number[]; groupStarts: number[] } {
  const slugCol = header.findIndex((h) => h.trim().toLowerCase() === 'parent slug')
  const order: string[] = []
  const byKey = new Map<string, Array<{ row: string[]; sheetRow: number }>>()
  dataRows.forEach((row, i) => {
    const slug = slugCol >= 0 ? (row[slugCol] ?? '').trim() : ''
    const key = slug || `__blank_${i}`
    let list = byKey.get(key)
    if (!list) { list = []; byKey.set(key, list); order.push(key) }
    list.push({ row, sheetRow: sheetRows?.[i] ?? i + 2 })
  })
  const orderedRows: string[][] = []
  const orderedSheetRows: number[] = []
  const groupStarts: number[] = []
  for (const key of order) {
    groupStarts.push(orderedRows.length)
    for (const entry of byKey.get(key)!) {
      orderedRows.push(entry.row)
      orderedSheetRows.push(entry.sheetRow)
    }
  }
  groupStarts.push(orderedRows.length) // sentinel end boundary
  return { orderedRows, orderedSheetRows, groupStarts }
}

// One bounded slice of the Pull, run under the job lock by stepPullJob. Every
// phase is idempotent, so re-running a batch after a failure or a closed tab just
// re-does no-ops until it gets past where it stopped.
async function runPullStep(job: PullJob, adminEmail: string): Promise<void> {
  const jobId = job.id
  try {
    if (job.phase === 'PRODUCTS') {
      if (!job.productsGrid || !job.shopImportJobId) throw new OwnerMessageError('Pull job is missing its products snapshot.')
      const header = job.productsGrid[0] ?? []
      const dataRows = job.productsGrid.slice(1)
      const stepStartedAt = Date.now()
      // Bounded chunks through shop's engine, cursor banked after every one -
      // the exact shape of the variations phase, and for the same reason: one
      // unbounded call over a big grid died at the dispatcher's 60s ceiling
      // before it could advance the phase, and every retry started over.
      // notify:false keeps a Pull from firing shop's import-complete email.
      let cursor = job.productsDone
      let created = job.prodCreated
      let updated = job.prodUpdated
      let skipped = job.prodSkipped
      let errors = job.prodErrors ?? []
      // Translate a 0-based index into the FILTERED data rows to the row the owner
      // sees in their sheet, so a row error points at the right place. Falls back
      // to the filtered position on jobs created before the row map existed.
      const prodSheetRow = (filteredIndex: number) => job.productsRowMap?.[filteredIndex] ?? (filteredIndex + 2)
      const reporter = makeRowReporter(jobId, job.recentItems ?? [])
      let chunksDone = 0
      while (cursor < dataRows.length && mayStartChunk(chunksDone, stepStartedAt)) {
        // Stop pressed since the step began? Leave the cursor where it is and
        // get out - rows already imported stay, the rest are never fed in.
        if ((await getPullJobStatus(jobId)) === 'CANCELLED') return
        chunksDone++
        const chunk = dataRows.slice(cursor, cursor + PROD_ROW_CHUNK)
        const subGrid = [header, ...chunk]
        // The engine matches by SKU/slug and diffs before writing, so feeding it
        // header + a slice is idempotent: a re-run chunk is all no-ops.
        // onRow names the product being written as it is written - the engine
        // announces each row before touching it, so the dialog can say "Updating
        // Chiro Plus…" rather than only counting chunks of 25.
        await processImportJob(job.shopImportJobId, gridToImportCsv(subGrid), adminEmail, null, {
          notify: false,
          onRow: (p) => reporter.onRow(p.name),
        })
        const sj = await getImportJobById(job.shopImportJobId)
        // The engine numbers rows within the chunk it was handed (data row i is
        // reported as i + 2); map that to the owner's sheet row.
        const chunkErrors = (sj?.errors ?? []).map((e) => ({ row: prodSheetRow(cursor + (e.row - 2)), reason: e.reason }))
        // Product-level attribute columns the engine cannot see, applied over the
        // same chunk right after its products exist. This used to be one unbounded
        // pass over the whole catalogue in the DELETIONS phase - thousands of
        // changed rows blew the 60s ceiling there; here it rides the products
        // cursor and time budget like everything else.
        const attributes = await applyProductFieldsPass(subGrid, { sheetRowFor: (i) => prodSheetRow(cursor + i) })
        // The designed-description column, same reasoning: not one of shop's CSV
        // columns, so the engine cannot see it. Runs after the engine so a row
        // that creates a product still gets its design.
        const designs = await applyDescriptionPuckPass(subGrid, { sheetRowFor: (i) => prodSheetRow(cursor + i) })
        created += sj?.createdCount ?? 0
        updated += (sj?.updatedCount ?? 0) + attributes.updated + designs.updated
        skipped += sj?.skippedCount ?? 0
        errors = [...errors, ...chunkErrors, ...attributes.errors, ...designs.errors]
        cursor += chunk.length
        // The shop job row carried per-chunk figures from the call above; put
        // the running totals back so shop's own import listing reads true.
        await updateImportJobProgress(job.shopImportJobId, { processedRows: cursor, createdCount: created, updatedCount: updated, skippedCount: skipped, errors })
        await updatePullJob(jobId, {
          status: 'RUNNING', error: null,
          productsDone: cursor,
          prodCreated: created, prodUpdated: updated, prodSkipped: skipped, prodErrors: errors,
          ...reporter.bank(),
        })
      }
      if (cursor >= dataRows.length) {
        // Leaving the phase clears the in-flight name: the deletions pass is bulk
        // statements with no row to announce, and a stale product name sitting
        // under "Removing items…" would read as if it were still being written.
        await updatePullJob(jobId, { phase: 'DELETIONS', status: 'RUNNING', error: null, currentItem: null, currentOffset: 0 })
      }
    } else if (job.phase === 'DELETIONS') {
      if (!job.productsGrid || !job.variationsGrid) throw new OwnerMessageError('Pull job is missing its sheet snapshot.')
      // Deletes only. The status column is now honoured by shop's import engine
      // itself, and the product-attribute pass runs alongside the products chunks
      // - so all that is left here is the deletion plan captured at start against
      // the FULL snapshot (the stored grids are filtered, and re-planning from
      // them would delete every skipped row). A job from before the plan column
      // existed has NULL there and full grids, so the old planner path still
      // serves it.
      //
      // Chunked, with a cursor, for the same reason the phases either side of it
      // are: two DELETE statements is not the same as two quick statements, since
      // each product cascades through its media, its variants, its variant values
      // and every module's per-product rows. An unbounded plan blew the sixty-
      // second ceiling, the platform killed the request part-way, and the retry
      // started the whole plan again - a Pull stuck on "Removing items…" for ever.
      const plan = job.deletionPlan ?? await planPullDeletions(job.productsGrid, job.variationsGrid, job.lastPushAt)
      const stepStartedAt = Date.now()
      let prodCursor = job.prodDeletionsDone
      let varCursor = job.varDeletionsDone
      let prodDeleted = job.prodDeleted
      let varDeleted = job.varDeleted
      let prodErrors = job.prodErrors ?? []
      let varErrors = job.varErrors ?? []

      let delChunks = 0
      while (prodCursor < plan.products.length && mayStartChunk(delChunks, stepStartedAt)) {
        if ((await getPullJobStatus(jobId)) === 'CANCELLED') return
        delChunks++
        const chunk = plan.products.slice(prodCursor, prodCursor + DELETE_CHUNK)
        const res = await applyProductDeletions(chunk)
        prodCursor += chunk.length
        prodDeleted += res.deleted
        prodErrors = [...prodErrors, ...res.errors]
        await updatePullJob(jobId, {
          status: 'RUNNING', error: null,
          prodDeletionsDone: prodCursor, prodDeleted, prodErrors,
          // Named so the dialog says which product is going, not just how many.
          currentItem: chunk[chunk.length - 1]?.name ?? null,
        })
      }

      let varDelChunks = 0
      while (varCursor < plan.variations.length && mayStartChunk(varDelChunks, stepStartedAt)) {
        if ((await getPullJobStatus(jobId)) === 'CANCELLED') return
        varDelChunks++
        const chunk = plan.variations.slice(varCursor, varCursor + DELETE_CHUNK)
        const res = await applyVariationDeletions(chunk)
        varCursor += chunk.length
        varDeleted += res.deleted
        varErrors = [...varErrors, ...res.errors]
        await updatePullJob(jobId, {
          status: 'RUNNING', error: null,
          varDeletionsDone: varCursor, varDeleted, varErrors,
          currentItem: chunk[chunk.length - 1]?.parentName ?? null,
        })
      }

      // Only move on once BOTH lists are exhausted; a step that ran out of time
      // part-way leaves the phase where it is and the next one carries on.
      if (prodCursor >= plan.products.length && varCursor >= plan.variations.length) {
        await updatePullJob(jobId, {
          phase: 'VARIATIONS', status: 'RUNNING', error: null,
          currentItem: null, currentOffset: 0,
        })
      }
    } else if (job.phase === 'VARIATIONS') {
      if (!job.variationsGrid) throw new OwnerMessageError('Pull job is missing its variations snapshot.')
      const header = job.variationsGrid[0] ?? []
      // Group the filtered rows so every row of a parent sits together, then chunk
      // on parent boundaries. The importer's value-rename pass (e.g. "Red" typed
      // over as "Crimson" down a column) only applies in place when it sees ALL of
      // a value's variants in one call - and a value belongs to exactly one parent
      // - so a parent split across two chunks used to fall back to delete-and-
      // recreate, losing the value id and its swatch. Whole parents per call fixes
      // that. Ordering is deterministic, so variationsDone still resumes cleanly.
      const { orderedRows, orderedSheetRows, groupStarts } = groupVariationRowsByParent(header, job.variationsGrid.slice(1), job.variationsRowMap)
      const stepStartedAt = Date.now()
      const reporter = makeRowReporter(jobId, job.recentItems ?? [])
      let cursor = job.variationsDone
      let created = job.varCreated
      let updated = job.varUpdated
      let errors = job.varErrors ?? []
      let varChunks = 0
      while (cursor < orderedRows.length && mayStartChunk(varChunks, stepStartedAt)) {
        // Stop pressed since the step began? Leave the cursor where it is and get
        // out - the rows already imported stay, the rest are simply never fed in.
        if ((await getPullJobStatus(jobId)) === 'CANCELLED') return
        // Extend to whole parents until the row target is met - never split a
        // parent. groupStarts ends with a sentinel = orderedRows.length, so the
        // last (possibly small) group still gets picked up.
        varChunks++
        let end = cursor
        for (const start of groupStarts) {
          if (start <= cursor) continue
          end = start
          if (end - cursor >= VAR_ROW_CHUNK) break
        }
        if (end <= cursor) end = orderedRows.length
        const chunk = orderedRows.slice(cursor, end)
        // Same commentary as products: the importer announces each variation as
        // it picks it up, named parent-first so a row reads the way the owner's
        // sheet does ("Chiro Plus - Black / High back").
        const res = await importVariationsCsv(gridToImportCsv([header, ...chunk]), {
          onRow: (p) => reporter.onRow(p.label ? `${p.parent} - ${p.label}` : p.parent),
        })
        // Importer numbers a data row as its 1-based CSV row (header = 1, first
        // data = 2); map back to the owner's sheet row via the ordered map.
        const chunkErrors = res.errors.map((e) => ({
          row: e.row >= 2 ? (orderedSheetRows[cursor + (e.row - 2)] ?? e.row) : e.row,
          reason: e.reason,
        }))
        cursor = end
        created += res.created
        updated += res.updated
        errors = [...errors, ...chunkErrors]
        await updatePullJob(jobId, {
          status: 'RUNNING', error: null,
          variationsDone: cursor,
          varCreated: created,
          varUpdated: updated,
          varErrors: errors,
          ...reporter.bank(),
          ...(cursor >= orderedRows.length ? { phase: 'DONE' } : {}),
        })
      }
      if (cursor >= orderedRows.length) {
        // Light: finalising reads the counters, never a grid.
        const reloaded = await getPullJobLight(jobId)
        if (reloaded) await finalizePullJob(reloaded)
      }
    } else {
      // phase DONE but not COMPLETED - a finalize that crashed mid-write. Redo it.
      await finalizePullJob(job)
    }
  } catch (err) {
    // A failed step leaves the cursor intact and the job FAILED, so Continue can
    // retry this same batch once the cause (a bad row, a transient DB blip) clears.
    // The in-chunk offset goes with it: the retry re-runs that chunk from the
    // banked cursor, so leaving the offset up would show a count that is ahead of
    // what actually landed for as long as the job sits paused.
    // Owner-facing sentence on the job, specifics in the log. A database blip
    // mid-import is exactly the case this must not turn into a wall of Prisma.
    const failure = describeFailure(err, 'pull')
    console.error('[google-sheet-products-for-shop/pull] step failed:', failure.detail)
    await updatePullJob(jobId, {
      status: 'FAILED', error: failure.message,
      currentItem: null, currentOffset: 0,
    })
  }
}

// Run exactly one bounded slice of the Pull and return the live snapshot. Safe to
// call repeatedly (the browser loops it) and safe to resume: every phase is
// idempotent, so re-running a batch after a failure or a closed tab just re-does
// no-ops until it gets past where it stopped. Returns null if the job is gone.
export async function stepPullJob(jobId: string, adminEmail: string): Promise<PullStatus | null> {
  const job = await getPullJobLight(jobId)
  if (!job) return null
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return pullStatus(job)

  // Serialise steps for one job. Two open tabs, or a wedged request and the
  // browser's retry, must never run a phase at once: the PRODUCTS phase would put
  // the sheet through shop's engine twice over and double every SKU-less row, and
  // the VARIATIONS cursor would be advanced twice for a single chunk. Losing the
  // race is not an error - the loser just reports the current snapshot below and
  // the browser polls again.
  try {
    await withPullStepLock(jobId, async () => {
      // Re-read inside the lock: the worker that held it may have advanced or even
      // finished the job between our first read and our acquiring it.
      // The one heavy read, and only the grid its own phase imports.
      const fresh = await getPullJobForStep(jobId)
      if (!fresh || fresh.status === 'COMPLETED' || fresh.status === 'CANCELLED') return
      await runPullStep(fresh, adminEmail)
    })
  } catch (err) {
    // Only the lock transaction's own failures land here - a dropped connection,
    // the 60s timeout, a broken lock query - never a phase error, which
    // runPullStep catches and records on the job. Swallowing this used to leave
    // the job RUNNING with nothing running it, so the browser looped forever on
    // an unchanging snapshot with no error anywhere. Record the failure on the
    // job instead: the UI shows the reason and offers Continue, whose retry is
    // safe because a FAILED job keeps its cursor. Best-effort - if the database
    // is the thing that is down, this write fails too and there is nothing more
    // to be done from here.
    // Message only, like every other log in this module: a database error object
    // can carry the datasource URL, and this one goes straight to the platform's
    // log where the owner's connection string has no business being.
    const failure = describeFailure(err, 'pull')
    console.error('[google-sheet-products-for-shop] pull step lock failed:', failure.detail)
    await updatePullJob(jobId, { status: 'FAILED', error: failure.message }).catch(() => {})
  }

  const after = await getPullJobLight(jobId)
  return after ? pullStatus(after) : null
}
