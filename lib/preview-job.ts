import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type {
  PreviewJob, PreviewJobStatus, PreviewPhase, PullPreview, PullDetected, StoredDeletionPlan,
} from '@/modules/google-sheet-products-for-shop/lib/types'

// The data layer for one gsp_preview_job row (see migrations/012_preview_job.sql):
// create it when the owner opens Pull, read it each step, bank the cursors as
// chunks complete, and finish it once. Mirrors pull-job.ts and push-job.ts, down
// to the raw SQL and the "never write to a cancelled job" rule.

function asGrid(v: unknown): string[][] | null {
  return Array.isArray(v) ? (v as string[][]) : null
}
function asGrids(v: unknown): string[][][] | null {
  return Array.isArray(v) ? (v as string[][][]) : null
}
function asStrings(v: unknown): string[] | null {
  return Array.isArray(v) ? (v as string[]).filter((s) => typeof s === 'string') : null
}
function asNumbers(v: unknown): number[] | null {
  return Array.isArray(v) ? (v as number[]) : null
}

function mapJob(r: Record<string, unknown>): PreviewJob {
  return {
    id: r.id as string,
    status: r.status as PreviewJobStatus,
    phase: r.phase as PreviewPhase,
    tabTitles: asStrings(r.tab_titles),
    tabsTotal: r.tabs_total as number,
    tabsDone: r.tabs_done as number,
    rawTabs: asGrids(r.raw_tabs),
    driveModifiedTime: (r.drive_modified_time as Date | null) ?? null,
    productsGrid: asGrid(r.products_grid),
    variationsGrid: asGrid(r.variations_grid),
    productsTotal: r.products_total as number,
    productsDone: r.products_done as number,
    variationsTotal: r.variations_total as number,
    variationsDone: r.variations_done as number,
    currentItem: (r.current_item as string | null) ?? null,
    preview: (r.preview as PullPreview | null) ?? null,
    filteredProducts: asGrid(r.filtered_products),
    productsRowMap: asNumbers(r.products_row_map),
    filteredVariations: asGrid(r.filtered_variations),
    variationsRowMap: asNumbers(r.variations_row_map),
    deletionPlan: (r.deletion_plan as StoredDeletionPlan | null) ?? null,
    detected: (r.detected as PullDetected | null) ?? null,
    lastPushAt: (r.last_push_at as Date | null) ?? null,
    error: (r.error as string | null) ?? null,
    fatal: r.fatal === true,
    runBy: (r.run_by as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

// Thrown when the partial unique index rejects a second RUNNING check - two
// starts raced past the app-level check. The route hands back the live one.
export class PreviewAlreadyRunningError extends Error {}

export async function createPreviewJob(data: { runBy: string }): Promise<{ id: string }> {
  try {
    const rows = await prisma.$queryRaw<[{ id: string }]>`
      INSERT INTO "gsp_preview_job" ("run_by") VALUES (${data.runBy}) RETURNING "id"
    `
    return rows[0]
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('gsp_preview_job_one_running') || msg.includes('23505')) {
      throw new PreviewAlreadyRunningError('A check of your sheet is already running.')
    }
    throw err
  }
}

export async function getPreviewJob(id: string): Promise<PreviewJob | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "gsp_preview_job" WHERE "id" = ${id} LIMIT 1`
  return rows[0] ? mapJob(rows[0]) : null
}

// How long a RUNNING check may go without a word before it counts as abandoned.
// A live check writes to its row every chunk - seconds apart - so anything this
// quiet is a browser that was closed mid-check, and nothing is coming back for
// it. Generously longer than the step lease, so a step that is merely slow is
// never mistaken for a dead one.
const PREVIEW_IDLE_MS = 3 * 60_000

// The check still running, if there is one. Two admin tabs, or a reopened
// dialog, join the one in flight rather than starting a second.
//
// A check that has gone quiet does not count. Nothing resumes a check by itself -
// the Pull dialog simply starts another - so a browser closed mid-check used to
// leave a RUNNING row that answered "yes" for ever, and a Push (which refuses
// while the sheet is being read) had no way past it short of a database edit.
export async function getRunningPreviewJob(): Promise<PreviewJob | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gsp_preview_job"
    WHERE "status" = 'RUNNING'
      AND ("updated_at" > now() - (${PREVIEW_IDLE_MS}::int4 * interval '1 millisecond')
           OR "step_lease_until" > now())
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapJob(rows[0]) : null
}

// Retire the RUNNING checks nobody is driving any more, so the one-at-a-time
// index does not refuse a fresh one. Called before a check is started and before
// a Push, which are the two places a stranded row would otherwise be felt.
export async function expireStalePreviewJobs(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_preview_job"
    SET "status" = 'CANCELLED', "raw_tabs" = NULL, "products_grid" = NULL, "variations_grid" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "status" = 'RUNNING'
      AND "updated_at" <= now() - (${PREVIEW_IDLE_MS}::int4 * interval '1 millisecond')
      AND ("step_lease_until" IS NULL OR "step_lease_until" <= now())
  `
}

export async function getPreviewJobStatus(id: string): Promise<PreviewJobStatus | null> {
  const rows = await prisma.$queryRaw<{ status: PreviewJobStatus }[]>`SELECT "status" FROM "gsp_preview_job" WHERE "id" = ${id} LIMIT 1`
  return rows[0]?.status ?? null
}

export type PreviewJobUpdate = {
  status?: PreviewJobStatus
  phase?: PreviewPhase
  tabTitles?: string[]
  tabsTotal?: number
  tabsDone?: number
  rawTabs?: string[][][] | null
  driveModifiedTime?: Date | null
  productsGrid?: string[][]
  variationsGrid?: string[][]
  productsTotal?: number
  productsDone?: number
  variationsTotal?: number
  variationsDone?: number
  currentItem?: string | null
  preview?: PullPreview
  filteredProducts?: string[][]
  productsRowMap?: number[]
  filteredVariations?: string[][]
  variationsRowMap?: number[]
  deletionPlan?: StoredDeletionPlan
  detected?: PullDetected
  lastPushAt?: Date | null
  error?: string | null
  fatal?: boolean
  // Set once the job has finished: the working grids are what make this row big,
  // and nothing reads them after the check is done. The FILTERED grids stay -
  // they are what a Pull started from this preview adopts.
  clearWorking?: boolean
}

export async function updatePreviewJob(id: string, fields: PreviewJobUpdate): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`"updated_at" = CURRENT_TIMESTAMP`]
  const json = (v: unknown) => Prisma.sql`${JSON.stringify(v)}::jsonb`
  if (fields.status !== undefined) sets.push(Prisma.sql`"status" = ${fields.status}`)
  if (fields.phase !== undefined) sets.push(Prisma.sql`"phase" = ${fields.phase}`)
  if (fields.tabTitles !== undefined) sets.push(Prisma.sql`"tab_titles" = ${json(fields.tabTitles)}`)
  if (fields.tabsTotal !== undefined) sets.push(Prisma.sql`"tabs_total" = ${fields.tabsTotal}`)
  if (fields.tabsDone !== undefined) sets.push(Prisma.sql`"tabs_done" = ${fields.tabsDone}`)
  if (fields.rawTabs !== undefined) {
    sets.push(fields.rawTabs === null ? Prisma.sql`"raw_tabs" = NULL` : Prisma.sql`"raw_tabs" = ${json(fields.rawTabs)}`)
  }
  if (fields.driveModifiedTime !== undefined) sets.push(Prisma.sql`"drive_modified_time" = ${fields.driveModifiedTime}`)
  if (fields.productsGrid !== undefined) sets.push(Prisma.sql`"products_grid" = ${json(fields.productsGrid)}`)
  if (fields.variationsGrid !== undefined) sets.push(Prisma.sql`"variations_grid" = ${json(fields.variationsGrid)}`)
  if (fields.productsTotal !== undefined) sets.push(Prisma.sql`"products_total" = ${fields.productsTotal}`)
  if (fields.productsDone !== undefined) sets.push(Prisma.sql`"products_done" = ${fields.productsDone}`)
  if (fields.variationsTotal !== undefined) sets.push(Prisma.sql`"variations_total" = ${fields.variationsTotal}`)
  if (fields.variationsDone !== undefined) sets.push(Prisma.sql`"variations_done" = ${fields.variationsDone}`)
  if (fields.currentItem !== undefined) sets.push(Prisma.sql`"current_item" = ${fields.currentItem}`)
  if (fields.preview !== undefined) sets.push(Prisma.sql`"preview" = ${json(fields.preview)}`)
  if (fields.filteredProducts !== undefined) sets.push(Prisma.sql`"filtered_products" = ${json(fields.filteredProducts)}`)
  if (fields.productsRowMap !== undefined) sets.push(Prisma.sql`"products_row_map" = ${json(fields.productsRowMap)}`)
  if (fields.filteredVariations !== undefined) sets.push(Prisma.sql`"filtered_variations" = ${json(fields.filteredVariations)}`)
  if (fields.variationsRowMap !== undefined) sets.push(Prisma.sql`"variations_row_map" = ${json(fields.variationsRowMap)}`)
  if (fields.deletionPlan !== undefined) sets.push(Prisma.sql`"deletion_plan" = ${json(fields.deletionPlan)}`)
  if (fields.detected !== undefined) sets.push(Prisma.sql`"detected" = ${json(fields.detected)}`)
  if (fields.lastPushAt !== undefined) sets.push(Prisma.sql`"last_push_at" = ${fields.lastPushAt}`)
  if (fields.error !== undefined) sets.push(Prisma.sql`"error" = ${fields.error}`)
  if (fields.fatal !== undefined) sets.push(Prisma.sql`"fatal" = ${fields.fatal}`)
  if (fields.clearWorking) {
    sets.push(Prisma.sql`"raw_tabs" = NULL`, Prisma.sql`"products_grid" = NULL`, Prisma.sql`"variations_grid" = NULL`)
  }
  // Never write to a cancelled job: a Stop lands while a step is mid-flight, and
  // that step's remaining writes would otherwise put the row back to RUNNING.
  await prisma.$executeRaw`UPDATE "gsp_preview_job" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${id} AND "status" <> 'CANCELLED'`
}

export async function cancelPreviewJob(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_preview_job"
    SET "status" = 'CANCELLED', "raw_tabs" = NULL, "products_grid" = NULL, "variations_grid" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" IN ('RUNNING', 'FAILED')
  `
}

// A finished check has served its purpose the moment a Pull adopts it (or the
// owner closes the dialog). Old rows carry filtered grids, so they are not left
// lying about: everything but the most recent handful is dropped whenever a new
// check starts. Cheap, and it keeps the table from growing without bound.
export async function pruneOldPreviewJobs(keep = 3): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "gsp_preview_job"
    WHERE "status" <> 'RUNNING'
      AND "id" NOT IN (
        SELECT "id" FROM "gsp_preview_job" WHERE "status" <> 'RUNNING' ORDER BY "created_at" DESC LIMIT ${keep}
      )
  `
}

// Step lease: claim/release a short lease so two workers (two tabs, a wedged
// request and the browser's retry) never step one job at once. Same single
// atomic UPDATE as the Push's - pooler-safe, and a killed step's lease simply
// expires. See lib/pull-run.ts for the full reasoning.
export async function claimPreviewStepLease(jobId: string, leaseMs: number): Promise<Date | null> {
  const claimed = await prisma.$queryRaw<Array<{ step_lease_until: Date }>>`
    UPDATE "gsp_preview_job"
    SET "step_lease_until" = now() + (${leaseMs}::int4 * interval '1 millisecond')
    WHERE "id" = ${jobId}
      AND ("step_lease_until" IS NULL OR "step_lease_until" < now())
    RETURNING "step_lease_until"
  `
  return claimed[0]?.step_lease_until ?? null
}

export async function releasePreviewStepLease(jobId: string, lease: Date): Promise<void> {
  await prisma
    .$executeRaw`UPDATE "gsp_preview_job" SET "step_lease_until" = NULL WHERE "id" = ${jobId} AND "step_lease_until" = ${lease}`
    .catch(() => {})
}
