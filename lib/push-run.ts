import { prisma } from '@/lib/db/prisma'
import { pushProductsGrid } from '@/modules/google-sheet-products-for-shop/lib/push-products'
import { pushOneVariationTab } from '@/modules/google-sheet-products-for-shop/lib/push-variations'
import { pushSuppliersTab } from '@/modules/google-sheet-products-for-shop/lib/push-supplier-catalogues'
import { ensureVariationTab } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { getSheetIds, deleteSheets, readHeaderRows } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { RESERVED_TAB_TITLES, isVariationTab } from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'
import { getConnection, stampLastPush, stampLastPushAttempt, setVariationTabManifest } from '@/modules/google-sheet-products-for-shop/lib/db'
import { writeSyncLog } from '@/modules/google-sheet-products-for-shop/lib/sync-log'
import {
  getPushJob, getPushJobStatus, updatePushJob, claimPushStepLease, releasePushStepLease,
} from '@/modules/google-sheet-products-for-shop/lib/push-job'
import type { PushJob, PushStatus } from '@/modules/google-sheet-products-for-shop/lib/types'

// How long one /push/step keeps starting new tab writes. Well under the module
// dispatcher's 60s ceiling so the slowest single tab still finishes and banks its
// cursor before the platform kills the request. Same value the Pull uses.
const STEP_TIME_BUDGET_MS = 35_000

// How long a claimed step lease lasts before another worker may take over. Longer
// than any single request can live, so a lease only ever expires on a dead step.
const STEP_LEASE_MS = 90_000

export function pushStatus(job: PushJob): PushStatus {
  return {
    pushJobId: job.id,
    status: job.status,
    phase: job.phase,
    done: job.status === 'COMPLETED',
    tabsTotal: job.tabsTotal,
    tabsDone: job.tabsDone,
    counts: {
      productsRows: job.productsRows,
      variationsRows: job.variationsRows,
      suppliersRows: job.suppliersRows,
      formulasKept: job.formulasKept,
    },
    error: job.error,
  }
}

// Delete the variation tabs that belong to no current product: a product that
// stopped being variable (its tab is not in `keep`), or a tab the owner renamed
// away from a product (same). A tab is only ever deleted when its header still
// carries the "Parent Slug" marker - the owner's own tabs never do, so they are
// safe. Classified by the same rule a Pull uses, so a tab whose columns the owner
// has rearranged is not read by one and ignored by the other. One getSheetIds and
// one batched header read classify every suspect without a read per tab.
async function deleteOrphanVariationTabs(spreadsheetId: string, keep: Set<string>): Promise<void> {
  const ids = await getSheetIds(spreadsheetId)
  const suspects = Object.keys(ids).filter((t) => !RESERVED_TAB_TITLES.has(t) && !keep.has(t))
  if (suspects.length === 0) return
  const headers = await readHeaderRows(spreadsheetId, suspects)
  const doomed = suspects
    .filter((t) => isVariationTab(t, headers[t] ?? []))
    .map((t) => ids[t])
    .filter((id): id is number => id !== undefined)
  await deleteSheets(spreadsheetId, doomed)
}

// Close the job exactly once: flip to COMPLETED atomically, write the audit rows,
// stamp the push and clear the snapshot. Mirrors finalizePullJob - only the worker
// that wins the flip writes the logs, so a crash-and-retry cannot duplicate them.
async function finalizePushJob(job: PushJob): Promise<void> {
  if (job.status === 'CANCELLED' || (await getPushJobStatus(job.id)) === 'CANCELLED') return
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "gsp_push_job" SET "status" = 'COMPLETED', "phase" = 'DONE', "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${job.id} AND "status" NOT IN ('COMPLETED', 'CANCELLED')
    RETURNING "id"
  `
  if (claimed.length === 0) return
  await writeSyncLog({ direction: 'PUSH', tab: 'PRODUCTS', status: 'COMPLETED', updatedCount: job.productsRows, runBy: job.runBy ?? undefined })
  await writeSyncLog({ direction: 'PUSH', tab: 'VARIATIONS', status: 'COMPLETED', updatedCount: job.variationsRows, runBy: job.runBy ?? undefined })
  await updatePushJob(job.id, { clearSnapshot: true })
}

// One bounded slice of the Push, run under the job lease. Every phase is
// idempotent, so re-running a slice after a failure or a closed tab just re-writes
// the same cells (formula preservation and all) until it gets past where it stopped.
async function runPushStep(job: PushJob): Promise<void> {
  const jobId = job.id
  try {
    const conn = await getConnection()
    if (!conn?.spreadsheetId) throw new Error('The Google Sheet connection is missing its spreadsheet.')
    const spreadsheetId = conn.spreadsheetId

    if (job.phase === 'PRODUCTS') {
      if (!job.productsGrid) throw new Error('Push job is missing its products snapshot.')
      const res = await pushProductsGrid(spreadsheetId, job.productsGrid)
      await stampLastPushAttempt()
      await updatePushJob(jobId, {
        phase: 'VARIATION_TABS', status: 'RUNNING', error: null,
        productsRows: res.rowCount, formulasKept: job.formulasKept + res.preservedFormulas,
      })
    } else if (job.phase === 'VARIATION_TABS') {
      if (!job.variationTabs) throw new Error('Push job is missing its variations snapshot.')
      const tabs = job.variationTabs
      // One sheet-list read up front so an already-present tab costs no per-tab
      // existence check; only genuinely new tabs are created.
      const existing = await getSheetIds(spreadsheetId)
      let cursor = job.tabsDone
      let written = job.writtenTitles ?? []
      let varRows = job.variationsRows
      let formulas = job.formulasKept
      const startedAt = Date.now()
      while (cursor < tabs.length && Date.now() - startedAt < STEP_TIME_BUDGET_MS) {
        if ((await getPushJobStatus(jobId)) === 'CANCELLED') return
        const t = tabs[cursor]!
        if (existing[t.title] === undefined) {
          await ensureVariationTab(spreadsheetId, t.title)
          existing[t.title] = 0 // mark present so a duplicate title in the list is not re-created
        }
        const res = await pushOneVariationTab(spreadsheetId, t.title, t.grid)
        written = [...written, t.title]
        varRows += res.rowCount
        formulas += res.preservedFormulas
        cursor += 1
        await stampLastPushAttempt()
        await updatePushJob(jobId, {
          status: 'RUNNING', error: null,
          tabsDone: cursor, writtenTitles: written, variationsRows: varRows, formulasKept: formulas,
          ...(cursor >= tabs.length ? { phase: 'CLEANUP' } : {}),
        })
      }
    } else if (job.phase === 'CLEANUP') {
      // Reference tab (written last: nobody's dependency), orphan-tab sweep,
      // manifest, deletion baseline. All bounded single operations.
      const suppliers = await pushSuppliersTab(spreadsheetId)
      await deleteOrphanVariationTabs(spreadsheetId, new Set(job.writtenTitles ?? []))
      const manifest = (job.variationTabs ?? []).map((t) => ({ slug: t.slug, title: t.title }))
      await setVariationTabManifest(manifest)
      await stampLastPush()
      await updatePushJob(jobId, { suppliersRows: suppliers.rowCount })
      const reloaded = await getPushJob(jobId)
      if (reloaded) await finalizePushJob(reloaded)
    } else {
      // phase DONE but not COMPLETED - a finalize that crashed mid-write. Redo it.
      await finalizePushJob(job)
    }
  } catch (err) {
    await updatePushJob(jobId, { status: 'FAILED', error: err instanceof Error ? err.message : 'Unknown error' })
  }
}

// Run exactly one bounded slice of the Push and return the live snapshot. Safe to
// call repeatedly (the browser loops it) and safe to resume: every phase is
// idempotent. Returns null if the job is gone.
export async function stepPushJob(jobId: string): Promise<PushStatus | null> {
  const job = await getPushJob(jobId)
  if (!job) return null
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return pushStatus(job)

  const lease = await claimPushStepLease(jobId, STEP_LEASE_MS)
  if (lease) {
    try {
      const fresh = await getPushJob(jobId)
      if (fresh && fresh.status !== 'COMPLETED' && fresh.status !== 'CANCELLED') await runPushStep(fresh)
    } catch (err) {
      // Only the lease/read machinery's own failures land here - a phase error is
      // caught inside runPushStep and recorded on the job. Record this too, so the
      // browser sees a reason and a Continue rather than looping on a stale snapshot.
      console.error('[google-sheet-products-for-shop] push step failed:', err)
      const reason = err instanceof Error ? err.message : 'Unknown error'
      await updatePushJob(jobId, { status: 'FAILED', error: `A push step could not run: ${reason}` }).catch(() => {})
    } finally {
      await releasePushStepLease(jobId, lease)
    }
  }

  const after = await getPushJob(jobId)
  return after ? pushStatus(after) : null
}
