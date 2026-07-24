import { processImportJob } from '@/modules/shop/lib/import-engine'
import { getImportJobById, updateImportJobProgress } from '@/modules/shop/lib/db/import-jobs'
import { importVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { applyStatusPass } from '@/modules/google-sheet-products-for-shop/lib/status-pass'
import { applyProductFieldsPass } from '@/modules/google-sheet-products-for-shop/lib/product-fields-pass'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { applyProductDeletions, applyVariationDeletions } from '@/modules/google-sheet-products-for-shop/lib/delete-pass'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { stampLastPull } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getPullJob, getPullJobStatus, updatePullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { prisma } from '@/lib/db/prisma'
import type { PullJob, PullStatus } from '@/modules/google-sheet-products-for-shop/lib/types'

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
const PROD_ROW_CHUNK = 25

// How long one /pull/step keeps starting new chunks. Well under the module
// dispatcher's 60s ceiling so the slowest single chunk still finishes and gets
// its cursor write in before the platform kills the request.
const STEP_TIME_BUDGET_MS = 35_000

// Live products progress is the job's own cursor, written after every chunk -
// no extra read of the shop import job per status poll. Once the products phase
// is behind us, products are simply all done.
function productsDoneFor(job: PullJob): number {
  return job.phase === 'PRODUCTS' ? job.productsDone : job.productsTotal
}

export async function pullStatus(job: PullJob): Promise<PullStatus> {
  const productsDone = productsDoneFor(job)
  return {
    pullJobId: job.id,
    status: job.status,
    phase: job.phase,
    done: job.status === 'COMPLETED',
    productsTotal: job.productsTotal,
    productsDone,
    variationsTotal: job.variationsTotal,
    variationsDone: job.variationsDone,
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
async function finalizePullJob(job: PullJob): Promise<void> {
  // A Stop that lands between the last chunk and here must not produce a
  // "COMPLETED" pair of audit rows for a pull that was abandoned. updatePullJob
  // already refuses to write a cancelled job, but the log rows and the last-pull
  // stamp go through their own writers, so check before any of it.
  if (job.status === 'CANCELLED' || (await getPullJobStatus(job.id)) === 'CANCELLED') return
  // Rows the start-of-pull diff proved identical never reached the importers;
  // they are skips all the same, and the audit log should say so.
  await writeSyncLog({
    direction: 'PULL', tab: 'PRODUCTS', status: 'COMPLETED',
    createdCount: job.prodCreated, updatedCount: job.prodUpdated,
    skippedCount: job.prodSkipped + (job.detected?.productsUnchanged ?? 0),
    archivedCount: job.prodDeleted, errors: job.prodErrors ?? [], runBy: job.runBy,
  })
  await writeSyncLog({
    direction: 'PULL', tab: 'VARIATIONS', status: 'COMPLETED',
    createdCount: job.varCreated, updatedCount: job.varUpdated,
    skippedCount: job.detected?.variationsUnchanged ?? 0,
    archivedCount: job.varDeleted, errors: job.varErrors ?? [], runBy: job.runBy,
  })
  await stampLastPull()
  await updatePullJob(job.id, { status: 'COMPLETED', phase: 'DONE', clearGrids: true })
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
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "gsp_pull_job"
    SET "step_lease_until" = now() + (${STEP_LEASE_MS}::int4 * interval '1 millisecond')
    WHERE "id" = ${jobId}
      AND ("step_lease_until" IS NULL OR "step_lease_until" < now())
    RETURNING "id"
  `
  if (claimed.length === 0) return false
  try {
    await fn()
  } finally {
    // Best-effort: a failed release just means the next step waits out the
    // lease. Never let it mask an error thrown by the step itself.
    await prisma
      .$executeRaw`UPDATE "gsp_pull_job" SET "step_lease_until" = NULL WHERE "id" = ${jobId}`
      .catch(() => {})
  }
  return true
}

// One bounded slice of the Pull, run under the job lock by stepPullJob. Every
// phase is idempotent, so re-running a batch after a failure or a closed tab just
// re-does no-ops until it gets past where it stopped.
async function runPullStep(job: PullJob, adminEmail: string): Promise<void> {
  const jobId = job.id
  try {
    if (job.phase === 'PRODUCTS') {
      if (!job.productsGrid || !job.shopImportJobId) throw new Error('Pull job is missing its products snapshot.')
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
      while (cursor < dataRows.length && Date.now() - stepStartedAt < STEP_TIME_BUDGET_MS) {
        // Stop pressed since the step began? Leave the cursor where it is and
        // get out - rows already imported stay, the rest are never fed in.
        if ((await getPullJobStatus(jobId)) === 'CANCELLED') return
        const chunk = dataRows.slice(cursor, cursor + PROD_ROW_CHUNK)
        // The engine matches by SKU/slug and diffs before writing, so feeding it
        // header + a slice is idempotent: a re-run chunk is all no-ops.
        await processImportJob(job.shopImportJobId, gridToImportCsv([header, ...chunk]), adminEmail, null, { notify: false })
        const sj = await getImportJobById(job.shopImportJobId)
        // The engine numbers rows within the chunk it was handed (data row i is
        // reported as i + 2); shift by the cursor to point at the grid row.
        const chunkErrors = (sj?.errors ?? []).map((e) => ({ row: cursor + e.row, reason: e.reason }))
        created += sj?.createdCount ?? 0
        updated += sj?.updatedCount ?? 0
        skipped += sj?.skippedCount ?? 0
        errors = [...errors, ...chunkErrors]
        cursor += chunk.length
        // The shop job row carried per-chunk figures from the call above; put
        // the running totals back so shop's own import listing reads true.
        await updateImportJobProgress(job.shopImportJobId, { processedRows: cursor, createdCount: created, updatedCount: updated, skippedCount: skipped, errors })
        await updatePullJob(jobId, {
          status: 'RUNNING', error: null,
          productsDone: cursor,
          prodCreated: created, prodUpdated: updated, prodSkipped: skipped, prodErrors: errors,
        })
      }
      if (cursor >= dataRows.length) {
        await updatePullJob(jobId, { phase: 'DELETIONS', status: 'RUNNING', error: null })
      }
    } else if (job.phase === 'DELETIONS') {
      if (!job.productsGrid || !job.variationsGrid) throw new Error('Pull job is missing its sheet snapshot.')
      // Status pass (the engine ignores the status column) over the stored grid -
      // which holds only changed rows, and a changed status is a changed row, so
      // nothing status-only slips past the filter. Then every deletion from the
      // plan captured at start against the FULL snapshot: the stored grids are
      // filtered, and planning from them would delete every skipped row. A job
      // from before the plan column existed has NULL there and full grids, so the
      // old planner path still serves it.
      const status = await applyStatusPass(job.productsGrid)
      // Product-level attribute columns the import engine cannot see, applied over
      // the same stored (changed-rows-only) grid the status pass uses.
      const attributes = await applyProductFieldsPass(job.productsGrid)
      const plan = job.deletionPlan ?? await planPullDeletions(job.productsGrid, job.variationsGrid, job.lastPushAt)
      const productDeletions = await applyProductDeletions(plan.products)
      const variationDeletions = await applyVariationDeletions(plan.variations)
      await updatePullJob(jobId, {
        phase: 'VARIATIONS', status: 'RUNNING', error: null,
        prodUpdated: job.prodUpdated + status.updated + attributes.updated,
        prodDeleted: productDeletions.deleted,
        varDeleted: variationDeletions.deleted,
        prodErrors: [...(job.prodErrors ?? []), ...status.errors, ...attributes.errors, ...productDeletions.errors],
        varErrors: [...(job.varErrors ?? []), ...variationDeletions.errors],
      })
    } else if (job.phase === 'VARIATIONS') {
      if (!job.variationsGrid) throw new Error('Pull job is missing its variations snapshot.')
      const header = job.variationsGrid[0] ?? []
      const dataRows = job.variationsGrid.slice(1)
      const stepStartedAt = Date.now()
      // Chunks keep going until the time budget is spent, the cursor written after
      // every one - so however slow the rows are, each step banks real progress and
      // the next Continue (or the browser's own loop) resumes from the last chunk,
      // never from the start of a batch it already half-did.
      let cursor = job.variationsDone
      let created = job.varCreated
      let updated = job.varUpdated
      let errors = job.varErrors ?? []
      while (cursor < dataRows.length && Date.now() - stepStartedAt < STEP_TIME_BUDGET_MS) {
        // Stop pressed since the step began? Leave the cursor where it is and get
        // out - the rows already imported stay, the rest are simply never fed in.
        if ((await getPullJobStatus(jobId)) === 'CANCELLED') return
        const chunk = dataRows.slice(cursor, cursor + VAR_ROW_CHUNK)
        // The importer re-derives options/variants from the DB per call, so feeding
        // it header + a slice of rows is correct even when a parent's rows straddle
        // two chunks: the second chunk finds what the first created.
        const res = await importVariationsCsv(gridToImportCsv([header, ...chunk]))
        cursor += chunk.length
        created += res.created
        updated += res.updated
        errors = [...errors, ...res.errors]
        await updatePullJob(jobId, {
          status: 'RUNNING', error: null,
          variationsDone: cursor,
          varCreated: created,
          varUpdated: updated,
          varErrors: errors,
          ...(cursor >= dataRows.length ? { phase: 'DONE' } : {}),
        })
      }
      if (cursor >= dataRows.length) {
        const reloaded = await getPullJob(jobId)
        if (reloaded) await finalizePullJob(reloaded)
      }
    } else {
      // phase DONE but not COMPLETED - a finalize that crashed mid-write. Redo it.
      await finalizePullJob(job)
    }
  } catch (err) {
    // A failed step leaves the cursor intact and the job FAILED, so Continue can
    // retry this same batch once the cause (a bad row, a transient DB blip) clears.
    await updatePullJob(jobId, { status: 'FAILED', error: err instanceof Error ? err.message : 'Unknown error' })
  }
}

// Run exactly one bounded slice of the Pull and return the live snapshot. Safe to
// call repeatedly (the browser loops it) and safe to resume: every phase is
// idempotent, so re-running a batch after a failure or a closed tab just re-does
// no-ops until it gets past where it stopped. Returns null if the job is gone.
export async function stepPullJob(jobId: string, adminEmail: string): Promise<PullStatus | null> {
  const job = await getPullJob(jobId)
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
      const fresh = await getPullJob(jobId)
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
    console.error('[google-sheet-products-for-shop] pull step lock failed:', err)
    const reason = err instanceof Error ? err.message : 'Unknown error'
    await updatePullJob(jobId, { status: 'FAILED', error: `A pull step could not run: ${reason}` }).catch(() => {})
  }

  const after = await getPullJob(jobId)
  return after ? pullStatus(after) : null
}
