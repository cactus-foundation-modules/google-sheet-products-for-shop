import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { PushJob, PushJobLight, PushPhase, PushJobStatus, PushVariationTab } from '@/modules/google-sheet-products-for-shop/lib/types'

// A Push is a resumable job (see migrations/007_push_job.sql). This is the whole
// data layer for the gsp_push_job row: create it at start with the catalogue
// snapshot, read it each step, advance the tab cursor as tabs are written, and
// finish it once. The grids are stored as JSONB; everything writes through raw
// SQL to match the rest of the module. Mirrors pull-job.ts.

type Cell = string | number | boolean

function asGrid(v: unknown): Cell[][] | null {
  return Array.isArray(v) ? (v as Cell[][]) : null
}
function asTabs(v: unknown): PushVariationTab[] | null {
  return Array.isArray(v) ? (v as PushVariationTab[]) : null
}
function asStrings(v: unknown): string[] | null {
  return Array.isArray(v) ? (v as string[]) : null
}

// Every column but the two snapshots, named rather than starred - see
// PushJobLight. A new column has to be added here on purpose.
const LIGHT_COLUMNS = Prisma.sql`
  "id", "status", "phase", "force", "written_titles", "tabs_total", "tabs_done",
  "products_rows", "variations_rows", "suppliers_rows", "formulas_kept",
  "error", "run_by", "created_at"
`

function mapLightJob(r: Record<string, unknown>): PushJobLight {
  return {
    id: r.id as string,
    status: r.status as PushJobStatus,
    phase: r.phase as PushPhase,
    force: r.force === true,
    writtenTitles: asStrings(r.written_titles),
    tabsTotal: r.tabs_total as number,
    tabsDone: r.tabs_done as number,
    productsRows: r.products_rows as number,
    variationsRows: r.variations_rows as number,
    suppliersRows: r.suppliers_rows as number,
    formulasKept: r.formulas_kept as number,
    error: (r.error as string | null) ?? null,
    runBy: (r.run_by as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

// The light row plus whichever snapshot the query asked for. Only
// getPushJobForStep may use this: it is the one caller that knows, from the
// phase it just read, which snapshot it is entitled to.
function mapJob(r: Record<string, unknown>): PushJob {
  return {
    ...mapLightJob(r),
    productsGrid: asGrid(r.products_grid),
    variationTabs: asTabs(r.variation_tabs),
  }
}

// Thrown when the partial unique index (gsp_push_job_one_running) rejects a
// second RUNNING job - two starts raced past the app-level check. Turned into 409.
export class PushAlreadyRunningError extends Error {}

// The job is created EMPTY: assembling the catalogue snapshot is the first two
// steps' work, not something POST /push does before it answers (see
// migrations/013). That is what puts the dialog on screen in the first second
// rather than after a minute of silence.
export async function createPushJob(data: { force: boolean; runBy: string }): Promise<{ id: string }> {
  try {
    const rows = await prisma.$queryRaw<[{ id: string }]>`
      INSERT INTO "gsp_push_job" ("force", "phase", "run_by")
      VALUES (${data.force}, 'BUILD_PRODUCTS', ${data.runBy})
      RETURNING "id"
    `
    return rows[0]
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('gsp_push_job_one_running') || msg.includes('23505')) {
      throw new PushAlreadyRunningError('A push is already in progress.')
    }
    throw err
  }
}

// One Push job, without its snapshots. What every caller but the stepper wants.
export async function getPushJobLight(id: string): Promise<PushJobLight | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS} FROM "gsp_push_job" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapLightJob(rows[0]) : null
}

// Which snapshot a phase reads. Kept beside the SQL that applies it so the two
// cannot drift.
//
//   BUILD_PRODUCTS / BUILD_TABS  BUILD them. They read neither.
//   PRODUCTS                     writes the Products tab from its grid.
//   VARIATION_TABS               writes each product tab from the tab list.
//   CLEANUP                      re-reads the tab list to fingerprint the manifest.
//   DONE                         is finalising, and reads neither.
//
// CLEANUP is the one to be careful with. It reads the tab list as
// `job.variationTabs ?? []`, so starving it would not fail - it would quietly
// write an EMPTY manifest, and the damage would land on the NEXT sync: no
// fingerprints, so no tab could be skipped, and the check's missing-tab guard
// would have nothing to check against. push-run.test.ts asserts this arm
// explicitly for that reason, because nothing else would notice.
//
// Gated in SQL because the cost being avoided is the transfer, not the decoding.
export async function getPushJobForStep(id: string): Promise<PushJob | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS},
      CASE WHEN "phase" = 'PRODUCTS' THEN "products_grid" END AS "products_grid",
      CASE WHEN "phase" IN ('VARIATION_TABS', 'CLEANUP') THEN "variation_tabs" END AS "variation_tabs"
    FROM "gsp_push_job" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapJob(rows[0]) : null
}

// The most recent job that has neither completed nor been cancelled - what the
// toolbar checks on load to decide whether to offer Continue. A FAILED job counts
// as unfinished: its cursor is intact, so Continue can retry from where it broke.
export async function getLatestUnfinishedPushJob(): Promise<PushJobLight | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS} FROM "gsp_push_job"
    WHERE "status" IN ('RUNNING', 'FAILED')
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapLightJob(rows[0]) : null
}

export async function getPushJobStatus(id: string): Promise<PushJobStatus | null> {
  const rows = await prisma.$queryRaw<{ status: PushJobStatus }[]>`SELECT "status" FROM "gsp_push_job" WHERE "id" = ${id} LIMIT 1`
  return rows[0]?.status ?? null
}

export type PushJobUpdate = {
  status?: PushJobStatus
  phase?: PushPhase
  // Written by the two BUILD phases, once each.
  productsGrid?: Cell[][]
  variationTabs?: PushVariationTab[]
  tabsTotal?: number
  tabsDone?: number
  writtenTitles?: string[]
  productsRows?: number
  variationsRows?: number
  suppliersRows?: number
  formulasKept?: number
  error?: string | null
  // Set true to clear the stored snapshot once the job is finished, so a completed
  // row does not carry the whole catalogue around.
  clearSnapshot?: boolean
}

export async function updatePushJob(id: string, fields: PushJobUpdate): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`"updated_at" = CURRENT_TIMESTAMP`]
  if (fields.status !== undefined) sets.push(Prisma.sql`"status" = ${fields.status}`)
  if (fields.phase !== undefined) sets.push(Prisma.sql`"phase" = ${fields.phase}`)
  if (fields.productsGrid !== undefined) sets.push(Prisma.sql`"products_grid" = ${JSON.stringify(fields.productsGrid)}::jsonb`)
  if (fields.variationTabs !== undefined) sets.push(Prisma.sql`"variation_tabs" = ${JSON.stringify(fields.variationTabs)}::jsonb`)
  if (fields.tabsTotal !== undefined) sets.push(Prisma.sql`"tabs_total" = ${fields.tabsTotal}`)
  if (fields.tabsDone !== undefined) sets.push(Prisma.sql`"tabs_done" = ${fields.tabsDone}`)
  if (fields.writtenTitles !== undefined) sets.push(Prisma.sql`"written_titles" = ${JSON.stringify(fields.writtenTitles)}::jsonb`)
  if (fields.productsRows !== undefined) sets.push(Prisma.sql`"products_rows" = ${fields.productsRows}`)
  if (fields.variationsRows !== undefined) sets.push(Prisma.sql`"variations_rows" = ${fields.variationsRows}`)
  if (fields.suppliersRows !== undefined) sets.push(Prisma.sql`"suppliers_rows" = ${fields.suppliersRows}`)
  if (fields.formulasKept !== undefined) sets.push(Prisma.sql`"formulas_kept" = ${fields.formulasKept}`)
  if (fields.error !== undefined) sets.push(Prisma.sql`"error" = ${fields.error}`)
  if (fields.clearSnapshot) sets.push(Prisma.sql`"products_grid" = NULL`, Prisma.sql`"variation_tabs" = NULL`)
  // Never write to a cancelled job: a Stop lands while a step is mid-flight, and
  // that step's remaining writes would otherwise put the row back to RUNNING.
  await prisma.$executeRaw`UPDATE "gsp_push_job" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${id} AND "status" <> 'CANCELLED'`
}

export async function cancelPushJob(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_push_job"
    SET "status" = 'CANCELLED', "products_grid" = NULL, "variation_tabs" = NULL, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" IN ('RUNNING', 'FAILED')
  `
}

// Step lease: claim/release a short lease so two workers (two tabs, a wedged
// request and the browser's retry) never step one job at once. Mirrors pull's
// withPullStepLock - a single atomic UPDATE, pooler-safe. See pull-run.ts.
export async function claimPushStepLease(jobId: string, leaseMs: number): Promise<Date | null> {
  const claimed = await prisma.$queryRaw<Array<{ step_lease_until: Date }>>`
    UPDATE "gsp_push_job"
    SET "step_lease_until" = now() + (${leaseMs}::int4 * interval '1 millisecond')
    WHERE "id" = ${jobId}
      AND ("step_lease_until" IS NULL OR "step_lease_until" < now())
    RETURNING "step_lease_until"
  `
  return claimed[0]?.step_lease_until ?? null
}

export async function releasePushStepLease(jobId: string, lease: Date): Promise<void> {
  await prisma
    .$executeRaw`UPDATE "gsp_push_job" SET "step_lease_until" = NULL WHERE "id" = ${jobId} AND "step_lease_until" = ${lease}`
    .catch(() => {})
}
