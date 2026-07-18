import { processImportJob } from '@/modules/shop/lib/import-engine'
import { getImportJobById } from '@/modules/shop/lib/db/import-jobs'
import { importVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { applyStatusPass } from '@/modules/google-sheet-products-for-shop/lib/status-pass'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import { applyProductDeletions, applyVariationDeletions } from '@/modules/google-sheet-products-for-shop/lib/delete-pass'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import { stampLastPull } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getPullJob, updatePullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import type { PullJob, PullStatus } from '@/modules/google-sheet-products-for-shop/lib/types'

// How many variation rows land in one database write. Kept small so the cursor
// advances often: even if the request is killed mid-step, everything up to the
// last finished chunk is saved and Continue picks up from there rather than
// re-running (and re-timing-out on) one big batch - which is exactly how a
// 60-row batch that could not finish inside the dispatcher's 60s ceiling left
// a Pull wedged at "0 of 83" forever.
const VAR_ROW_CHUNK = 10

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
  await writeSyncLog({
    direction: 'PULL', tab: 'PRODUCTS', status: 'COMPLETED',
    createdCount: job.prodCreated, updatedCount: job.prodUpdated, skippedCount: job.prodSkipped,
    archivedCount: job.prodDeleted, errors: job.prodErrors ?? [], runBy: job.runBy,
  })
  await writeSyncLog({
    direction: 'PULL', tab: 'VARIATIONS', status: 'COMPLETED',
    createdCount: job.varCreated, updatedCount: job.varUpdated,
    archivedCount: job.varDeleted, errors: job.varErrors ?? [], runBy: job.runBy,
  })
  await stampLastPull()
  await updatePullJob(job.id, { status: 'COMPLETED', phase: 'DONE', clearGrids: true })
}

// Run exactly one bounded slice of the Pull and return the live snapshot. Safe to
// call repeatedly (the browser loops it) and safe to resume: every phase is
// idempotent, so re-running a batch after a failure or a closed tab just re-does
// no-ops until it gets past where it stopped. Returns null if the job is gone.
export async function stepPullJob(jobId: string, adminEmail: string): Promise<PullStatus | null> {
  const job = await getPullJob(jobId)
  if (!job) return null
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return pullStatus(job)

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
      // Status pass (the engine ignores the status column), then every deletion
      // planned against the push baseline, products first then variations - the
      // same order and planner the one-shot Pull used.
      const status = await applyStatusPass(job.productsGrid)
      const plan = await planPullDeletions(job.productsGrid, job.variationsGrid, job.lastPushAt)
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

  const after = await getPullJob(jobId)
  return after ? pullStatus(after) : null
}
