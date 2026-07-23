import { processImportJob } from '@/modules/shop/lib/import-engine'
import { getImportJobById } from '@/modules/shop/lib/db/import-jobs'
import { importVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { applyStatusPass } from '@/modules/google-sheet-products-for-shop/lib/status-pass'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { applyProductDeletions, applyVariationDeletions } from '@/modules/google-sheet-products-for-shop/lib/delete-pass'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { stampLastPull } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getPullJob, getPullJobStatus, updatePullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { prisma } from '@/lib/db/prisma'
import type { PullJob, PullStatus } from '@/modules/google-sheet-products-for-shop/lib/types'

// How many variation rows land in one importer call. Each call carries a fixed
// per-parent cost (load the parent, its variants, their fields, its options and
// images once), so a bigger chunk amortises that over more rows. It stayed at 10
// only because every row used to re-read its child to check for changes; now that
// the importer diffs a pre-loaded field map in memory and flushes its writes
// together, 25 rows finish comfortably inside the dispatcher's 60s ceiling. The
// cursor still advances after every chunk, so a killed step re-does at most one
// chunk of idempotent no-ops - never the whole batch that once wedged a Pull.
const VAR_ROW_CHUNK = 25

// How long one /pull/step keeps starting new chunks. Well under the module
// dispatcher's 60s ceiling so the slowest single chunk still finishes and gets
// its cursor write in before the platform kills the request.
const STEP_TIME_BUDGET_MS = 35_000

// Live products progress comes from the shop import job's own processed_rows,
// which processImportJob updates every 25 rows as it runs. Once the products
// phase is behind us, products are simply all done.
async function productsDoneFor(job: PullJob): Promise<number> {
  if (job.phase !== 'PRODUCTS') return job.productsTotal
  if (!job.shopImportJobId) return 0
  const sj = await getImportJobById(job.shopImportJobId)
  return sj?.processedRows ?? 0
}

export async function pullStatus(job: PullJob): Promise<PullStatus> {
  const productsDone = await productsDoneFor(job)
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

// A fixed namespace for this module's transaction-scoped advisory locks, so a
// job-id hash cannot collide with an unrelated advisory lock taken elsewhere in
// the app. Arbitrary but constant, and within int4 - what pg_advisory_* take.
const PULL_LOCK_NAMESPACE = 0x67737001 // "gsp\x01", a signed int4

// Run `fn` only when no other worker is already stepping this job, serialised by a
// transaction-scoped advisory lock keyed on the job id. Returns false, without
// running `fn`, when another worker holds the lock.
//
// pg_try_advisory_XACT_lock rather than the session-level pg_advisory_lock on
// purpose: an xact lock lives and dies with this transaction, so a step the
// platform kills at the module dispatcher's 60s ceiling takes its lock down with
// the request instead of stranding it - the next Continue is free to claim the
// job with no lease to wait out. It also survives connection pooling, where a
// session lock taken on one pooled connection would not be held on the next.
async function withPullStepLock(jobId: string, fn: () => Promise<void>): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<[{ locked: boolean }]>`
        SELECT pg_try_advisory_xact_lock(${PULL_LOCK_NAMESPACE}, hashtext(${jobId})) AS "locked"
      `
      if (!rows[0]?.locked) return false
      await fn()
      return true
    },
    // A step runs right up to the dispatcher's ceiling, so the transaction (and
    // its lock) must be allowed to live that long. maxWait is only how long to
    // queue for a pooled connection to begin the transaction.
    { timeout: 60_000, maxWait: 10_000 },
  )
}

// One bounded slice of the Pull, run under the job lock by stepPullJob. Every
// phase is idempotent, so re-running a batch after a failure or a closed tab just
// re-does no-ops until it gets past where it stopped.
async function runPullStep(job: PullJob, adminEmail: string): Promise<void> {
  const jobId = job.id
  try {
    if (job.phase === 'PRODUCTS') {
      if (!job.productsGrid || !job.shopImportJobId) throw new Error('Pull job is missing its products snapshot.')
      // Products go through shop's own engine in one blocking step; the browser
      // reads live "X of Y" from the shop import job while this runs. notify:false
      // keeps a Pull from firing shop's import-complete email.
      await processImportJob(job.shopImportJobId, gridToImportCsv(job.productsGrid), adminEmail, null, { notify: false })
      const sj = await getImportJobById(job.shopImportJobId)
      await updatePullJob(jobId, {
        phase: 'DELETIONS', status: 'RUNNING', error: null,
        prodCreated: sj?.createdCount ?? 0,
        prodUpdated: sj?.updatedCount ?? 0,
        prodSkipped: sj?.skippedCount ?? 0,
        prodErrors: sj?.errors ?? [],
      })
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
      const plan = job.deletionPlan ?? await planPullDeletions(job.productsGrid, job.variationsGrid, job.lastPushAt)
      const productDeletions = await applyProductDeletions(plan.products)
      const variationDeletions = await applyVariationDeletions(plan.variations)
      await updatePullJob(jobId, {
        phase: 'VARIATIONS', status: 'RUNNING', error: null,
        prodUpdated: job.prodUpdated + status.updated,
        prodDeleted: productDeletions.deleted,
        varDeleted: variationDeletions.deleted,
        prodErrors: [...(job.prodErrors ?? []), ...status.errors, ...productDeletions.errors],
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
    // the 60s timeout - never a phase error, which runPullStep catches and records
    // on the job. Leave the job as it stands and report the snapshot.
    console.error('[google-sheet-products-for-shop] pull step lock failed:', err)
  }

  const after = await getPullJob(jobId)
  return after ? pullStatus(after) : null
}
