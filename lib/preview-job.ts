import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type {
  PreviewJob, PreviewJobLight, PreviewJobStatus, PreviewPhase, PullPreview, PullDetected, StoredDeletionPlan,
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

// Every column except the three heavy ones, named rather than starred. A
// `SELECT *` here reads 4MB off Deskwell's row whatever the caller wanted, and
// that is exactly the bill this list exists to stop paying - so the columns are
// spelled out, and a new one has to be added here on purpose.
const LIGHT_COLUMNS = Prisma.sql`
  "id", "status", "phase", "tab_titles", "tabs_total", "tabs_done", "drive_modified_time",
  "products_total", "products_done", "variations_total", "variations_done", "current_item",
  "preview", "filtered_products", "products_row_map", "filtered_variations", "variations_row_map",
  "deletion_plan", "detected", "last_push_at", "error", "fatal", "run_by", "created_at", "updated_at"
`

function mapLightJob(r: Record<string, unknown>): PreviewJobLight {
  return {
    id: r.id as string,
    status: r.status as PreviewJobStatus,
    phase: r.phase as PreviewPhase,
    tabTitles: asStrings(r.tab_titles),
    tabsTotal: r.tabs_total as number,
    tabsDone: r.tabs_done as number,
    driveModifiedTime: (r.drive_modified_time as Date | null) ?? null,
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
    updatedAt: (r.updated_at as Date | undefined) ?? (r.created_at as Date),
  }
}

// The light row plus whichever grids the query actually asked for. A grid the
// SELECT gated away arrives as undefined and maps to null, which is why only
// getPreviewJobForStep may use this - it is the one caller that knows, from the
// phase it just read, which grids it is entitled to.
function mapJob(r: Record<string, unknown>): PreviewJob {
  return {
    ...mapLightJob(r),
    rawTabs: asGrids(r.raw_tabs),
    productsGrid: asGrid(r.products_grid),
    variationsGrid: asGrid(r.variations_grid),
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

// One check, without its grids. What every caller but the stepper wants.
export async function getPreviewJobLight(id: string): Promise<PreviewJobLight | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS} FROM "gsp_preview_job" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapLightJob(rows[0]) : null
}

// Which grids a phase reads. Kept beside the SQL that applies it so the two
// cannot drift: a phase added to the runner without a line here would get no
// grid at all and say it had lost its copy of the sheet.
//
//   READ       accumulates the per-tab bodies. It holds the Products tab too, but
//              only the step that finishes the tabs actually reads it, so that one
//              fetches it on its own through getPreviewJobProductsGrid rather than
//              every READ step carrying 2.2MB it will not open.
//   PRODUCTS   compares Products rows. Never looks at the variations grid.
//   DELETIONS  needs both, to work out what is in neither.
//   VARIATIONS compares parent groups. Never looks at the products grid.
//   DONE       is finalising, and reads no grid at all.
//
// The gating is done in SQL rather than after the fact because the cost being
// avoided is the transfer, not the decoding: a CASE that yields NULL sends
// nothing down the wire, where selecting the column and ignoring it in
// JavaScript would have paid the whole bill and thrown the result away.
export async function getPreviewJobForStep(id: string): Promise<PreviewJob | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS},
      CASE WHEN "phase" IN ('PRODUCTS', 'DELETIONS') THEN "products_grid" END AS "products_grid",
      CASE WHEN "phase" IN ('DELETIONS', 'VARIATIONS') THEN "variations_grid" END AS "variations_grid",
      CASE WHEN "phase" = 'READ' THEN "raw_tabs" END AS "raw_tabs"
    FROM "gsp_preview_job" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapJob(rows[0]) : null
}

// The Products tab on its own, for the single READ step that finishes the tabs
// and merges everything. Every other READ step would only be carrying it about.
export async function getPreviewJobProductsGrid(id: string): Promise<string[][] | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "products_grid" FROM "gsp_preview_job" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? asGrid(rows[0].products_grid) : null
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
export async function getRunningPreviewJob(): Promise<PreviewJobLight | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS} FROM "gsp_preview_job"
    WHERE "status" = 'RUNNING'
      AND ("updated_at" > now() - (${PREVIEW_IDLE_MS}::int4 * interval '1 millisecond')
           OR "step_lease_until" > now())
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapLightJob(rows[0]) : null
}

// Stand down the RUNNING checks nobody is driving any more, so the one-at-a-time
// index does not refuse a fresh one on behalf of a ghost.
//
// Two things this deliberately does NOT do any more, both learned the hard way
// from a live check that stopped at 250 products of 445 and could not be picked
// up again:
//
//   - It does not CANCEL. Cancelled means the owner pressed Stop, and a job in
//     that state is offered no way back. A check nobody is driving has not been
//     stopped by anyone; its cursor is intact and it deserves the same treatment
//     as any other interrupted job, which is FAILED - the state this module has
//     always used for "did not finish, carry on from here".
//   - It does not throw the working grids away. Nulling them is what made the
//     250 products already compared unrecoverable, so the only button on offer
//     had to start again from the first tab. The row is bounded by the prune
//     above; the work is not worth less than the bytes.
export async function expireStalePreviewJobs(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_preview_job"
    SET "status" = 'FAILED',
        "error" = 'The check stopped part-way through. Nothing is lost - carry on from where it got to.',
        "fatal" = false,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "status" = 'RUNNING'
      AND "updated_at" <= now() - (${PREVIEW_IDLE_MS}::int4 * interval '1 millisecond')
      AND ("step_lease_until" IS NULL OR "step_lease_until" <= now())
  `
}

// The most recent check worth carrying on with: one still running, or one that
// stopped part-way with its place kept. A check the owner cancelled is NOT
// resumable - they meant stop - and neither is one that finished.
//
// This is what stops "Check again" throwing away the work already done. It used
// to create a fresh job every time, so a check that got three quarters of the way
// through a big catalogue started again at the first tab, for ever.
export async function getResumablePreviewJob(): Promise<PreviewJobLight | null> {
  // "products_grid IS NOT NULL" stays in the WHERE - it is the test for "this one
  // still has its working state, so it can be carried on". Testing it costs
  // nothing; SELECTing it is what cost 2.2MB.
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${LIGHT_COLUMNS} FROM "gsp_preview_job"
    WHERE "status" = 'RUNNING'
       OR ("status" = 'FAILED' AND "fatal" = false AND "products_grid" IS NOT NULL)
    ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapLightJob(rows[0]) : null
}

// Put a stopped check back to work. Only ever applied to a job the query above
// judged resumable, and it clears the lease so the next step can claim it at once
// rather than waiting out a lease left behind by a killed request.
export async function resumePreviewJob(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_preview_job"
    SET "status" = 'RUNNING', "error" = NULL, "step_lease_until" = NULL, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "status" = 'FAILED' AND "fatal" = false
      -- Only one check may be RUNNING, and a partial unique index enforces it.
      -- Putting this one back to work while another still holds that slot would
      -- be a constraint violation surfacing as a 500 rather than a refusal, so it
      -- is checked here instead. Hard to reach and cheap to rule out.
      AND NOT EXISTS (SELECT 1 FROM "gsp_preview_job" WHERE "status" = 'RUNNING')
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
    SET "step_lease_until" = now() + (${leaseMs}::int4 * interval '1 millisecond'),
        -- Claiming a lease IS activity, and must count as such. It did not, and
        -- that is what made a working check look abandoned: a phase whose setup
        -- is long writes nothing until its first chunk lands, so if the platform
        -- killed that step before it got there, updated_at stayed frozen while
        -- the browser was busily asking for step after step. The idle sweep below
        -- then declared a job that was being worked on dead.
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${jobId}
      AND ("step_lease_until" IS NULL OR "step_lease_until" < now())
    RETURNING "step_lease_until"
  `
  return claimed[0]?.step_lease_until ?? null
}

// Touch the job without changing anything, so a phase about to spend a long time
// in one call still counts as alive while it does.
export async function heartbeatPreviewJob(jobId: string): Promise<void> {
  await prisma
    .$executeRaw`UPDATE "gsp_preview_job" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${jobId} AND "status" = 'RUNNING'`
    .catch(() => {})
}

export async function releasePreviewStepLease(jobId: string, lease: Date): Promise<void> {
  await prisma
    .$executeRaw`UPDATE "gsp_preview_job" SET "step_lease_until" = NULL WHERE "id" = ${jobId} AND "step_lease_until" = ${lease}`
    .catch(() => {})
}
