import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { PullJob, PullPhase, PullJobStatus, PullDetected, StoredDeletionPlan, SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// A Pull is a resumable job (see migrations/002_pull_job.sql). This is the whole
// data layer for the gsp_pull_job row: create it at start, read it each step,
// update the cursor/counts as batches complete, and finish it once. The grids are
// stored as JSONB and read back as string[][]; everything writes through raw SQL
// to match the rest of the module.

function asGrid(v: unknown): string[][] | null {
  return Array.isArray(v) ? (v as string[][]) : null
}
function asErrors(v: unknown): SyncRowError[] | null {
  return Array.isArray(v) ? (v as SyncRowError[]) : null
}

function mapJob(r: Record<string, unknown>): PullJob {
  return {
    id: r.id as string,
    status: r.status as PullJobStatus,
    phase: r.phase as PullPhase,
    productsGrid: asGrid(r.products_grid),
    variationsGrid: asGrid(r.variations_grid),
    deletionPlan: (r.deletion_plan as StoredDeletionPlan | null) ?? null,
    lastPushAt: (r.last_push_at as Date | null) ?? null,
    shopImportJobId: (r.shop_import_job_id as string | null) ?? null,
    detected: (r.detected as PullDetected | null) ?? null,
    productsTotal: r.products_total as number,
    variationsTotal: r.variations_total as number,
    variationsDone: r.variations_done as number,
    prodCreated: r.prod_created as number,
    prodUpdated: r.prod_updated as number,
    prodSkipped: r.prod_skipped as number,
    prodDeleted: r.prod_deleted as number,
    varCreated: r.var_created as number,
    varUpdated: r.var_updated as number,
    varDeleted: r.var_deleted as number,
    prodErrors: asErrors(r.prod_errors),
    varErrors: asErrors(r.var_errors),
    error: (r.error as string | null) ?? null,
    runBy: (r.run_by as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export async function createPullJob(data: {
  productsGrid: string[][]
  variationsGrid: string[][]
  deletionPlan: StoredDeletionPlan
  lastPushAt: Date | null
  shopImportJobId: string
  detected: PullDetected | null
  productsTotal: number
  variationsTotal: number
  runBy: string
}): Promise<{ id: string }> {
  const rows = await prisma.$queryRaw<[{ id: string }]>`
    INSERT INTO "gsp_pull_job" (
      "products_grid", "variations_grid", "deletion_plan", "last_push_at", "shop_import_job_id",
      "detected", "products_total", "variations_total", "run_by"
    ) VALUES (
      ${JSON.stringify(data.productsGrid)}::jsonb,
      ${JSON.stringify(data.variationsGrid)}::jsonb,
      ${JSON.stringify(data.deletionPlan)}::jsonb,
      ${data.lastPushAt},
      ${data.shopImportJobId},
      ${data.detected ? JSON.stringify(data.detected) : null}::jsonb,
      ${data.productsTotal},
      ${data.variationsTotal},
      ${data.runBy}
    )
    RETURNING "id"
  `
  return rows[0]
}

export async function getPullJob(id: string): Promise<PullJob | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "gsp_pull_job" WHERE "id" = ${id} LIMIT 1`
  return rows[0] ? mapJob(rows[0]) : null
}

// The most recent job that has neither completed nor been cancelled - what the
// toolbar checks on load to decide whether to offer Continue. A FAILED job counts
// as unfinished: its cursor is intact, so Continue can retry from where it broke.
export async function getLatestUnfinishedPullJob(): Promise<PullJob | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gsp_pull_job"
    WHERE "status" IN ('RUNNING', 'FAILED')
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapJob(rows[0]) : null
}

// Just the status column. The variations loop reads this between chunks so a
// Stop pressed mid-run takes effect at the next chunk boundary rather than after
// the whole step's time budget - one tiny query per 25 rows.
export async function getPullJobStatus(id: string): Promise<PullJobStatus | null> {
  const rows = await prisma.$queryRaw<{ status: PullJobStatus }[]>`SELECT "status" FROM "gsp_pull_job" WHERE "id" = ${id} LIMIT 1`
  return rows[0]?.status ?? null
}

export type PullJobUpdate = {
  status?: PullJobStatus
  phase?: PullPhase
  variationsDone?: number
  prodCreated?: number
  prodUpdated?: number
  prodSkipped?: number
  prodDeleted?: number
  varCreated?: number
  varUpdated?: number
  varDeleted?: number
  prodErrors?: SyncRowError[]
  varErrors?: SyncRowError[]
  error?: string | null
  // Set true to clear the stored grids once the job is finished, so a completed
  // row does not carry the whole catalogue snapshot around.
  clearGrids?: boolean
}

export async function updatePullJob(id: string, fields: PullJobUpdate): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`"updated_at" = CURRENT_TIMESTAMP`]
  if (fields.status !== undefined) sets.push(Prisma.sql`"status" = ${fields.status}`)
  if (fields.phase !== undefined) sets.push(Prisma.sql`"phase" = ${fields.phase}`)
  if (fields.variationsDone !== undefined) sets.push(Prisma.sql`"variations_done" = ${fields.variationsDone}`)
  if (fields.prodCreated !== undefined) sets.push(Prisma.sql`"prod_created" = ${fields.prodCreated}`)
  if (fields.prodUpdated !== undefined) sets.push(Prisma.sql`"prod_updated" = ${fields.prodUpdated}`)
  if (fields.prodSkipped !== undefined) sets.push(Prisma.sql`"prod_skipped" = ${fields.prodSkipped}`)
  if (fields.prodDeleted !== undefined) sets.push(Prisma.sql`"prod_deleted" = ${fields.prodDeleted}`)
  if (fields.varCreated !== undefined) sets.push(Prisma.sql`"var_created" = ${fields.varCreated}`)
  if (fields.varUpdated !== undefined) sets.push(Prisma.sql`"var_updated" = ${fields.varUpdated}`)
  if (fields.varDeleted !== undefined) sets.push(Prisma.sql`"var_deleted" = ${fields.varDeleted}`)
  if (fields.prodErrors !== undefined) sets.push(Prisma.sql`"prod_errors" = ${fields.prodErrors.length ? JSON.stringify(fields.prodErrors) : null}::jsonb`)
  if (fields.varErrors !== undefined) sets.push(Prisma.sql`"var_errors" = ${fields.varErrors.length ? JSON.stringify(fields.varErrors) : null}::jsonb`)
  if (fields.error !== undefined) sets.push(Prisma.sql`"error" = ${fields.error}`)
  if (fields.clearGrids) sets.push(Prisma.sql`"products_grid" = NULL`, Prisma.sql`"variations_grid" = NULL`, Prisma.sql`"deletion_plan" = NULL`)
  // Never write to a cancelled job. A Stop lands while a step is mid-flight, and
  // that step's remaining writes would otherwise put the row back to RUNNING (or
  // FAILED) and the job would offer Continue again after the owner stopped it.
  await prisma.$executeRaw`UPDATE "gsp_pull_job" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${id} AND "status" <> 'CANCELLED'`
}

export async function cancelPullJob(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_pull_job"
    SET "status" = 'CANCELLED', "products_grid" = NULL, "variations_grid" = NULL, "deletion_plan" = NULL, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" IN ('RUNNING', 'FAILED')
  `
}
