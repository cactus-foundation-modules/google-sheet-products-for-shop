import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PullJob } from '@/modules/google-sheet-products-for-shop/lib/types'

// Does a Pull of a big catalogue actually FINISH, and does every phase get the
// grid it needs?
//
// The third of the trio, after preview-run.test.ts and push-run.test.ts, and the
// one with the most at stake: a Pull WRITES to the shop. It is a stepped job
// against a sixty-second ceiling, so the state machine is what matters - from a
// standing start, does calling /step repeatedly reach COMPLETED, in bounded
// steps, having fed every row through exactly once, surviving a step the platform
// kills, and stopping when told to?
//
// And, as with the Push: the job row is no longer read whole. Each step is served
// only the grid its own phase imports (see getPullJobForStep). That gate lives in
// SQL, which no unit test can reach - so the fake below applies the SAME gate,
// and a phase that quietly started reading the other grid fails here rather than
// half way through rewriting a customer's catalogue.
//
// Everything below the stepper is faked (the import engines, the deletion passes,
// the database) and the clock is simulated so the time budget genuinely bites.
const PRODUCT_ROWS = 300
const VARIATION_ROWS = 600
const PARENTS = 60

let now = 1_700_000_000_000
const advance = (ms: number) => { now += ms }

let job: PullJob
let writeCount = 0
let swallowNextWrite = false
let served: Array<{ phase: string; productsGrid: boolean; variationsGrid: boolean }> = []

// Rows actually fed to each importer, so the assertions can prove exactly-once.
let importedProductRows: string[] = []
let importedVariationRows: string[] = []

function freshJob(): PullJob {
  return {
    id: 'pull-1', status: 'RUNNING', phase: 'PRODUCTS',
    productsGrid: [['sku', 'name'], ...Array.from({ length: PRODUCT_ROWS }, (_, i) => [`SKU${i}`, `Product ${i}`])],
    variationsGrid: [
      ['Parent Slug', 'Option 1', 'Value 1'],
      ...Array.from({ length: VARIATION_ROWS }, (_, i) => [`product-${i % PARENTS}`, 'Size', `V${i}`]),
    ],
    productsRowMap: Array.from({ length: PRODUCT_ROWS }, (_, i) => i + 2),
    variationsRowMap: Array.from({ length: VARIATION_ROWS }, (_, i) => i + 2),
    deletionPlan: { products: [], variations: [] },
    lastPushAt: null, shopImportJobId: 'import-1',
    detected: {
      productsCreate: 0, productsUpdate: PRODUCT_ROWS, productsDelete: 0,
      variationsCreate: 0, variationsUpdate: VARIATION_ROWS, variationsDelete: 0,
    },
    productsTotal: PRODUCT_ROWS, productsDone: 0,
    variationsTotal: VARIATION_ROWS, variationsDone: 0,
    prodCreated: 0, prodUpdated: 0, prodSkipped: 0, prodDeleted: 0,
    varCreated: 0, varUpdated: 0, varDeleted: 0,
    prodDeletionsDone: 0, varDeletionsDone: 0,
    prodErrors: null, varErrors: null,
    currentItem: null, currentOffset: 0, recentItems: null,
    error: null, runBy: 'admin', createdAt: new Date(now),
  }
}

const copy = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)) as T)

// Which grid each phase is entitled to. MUST match the CASE arms in
// getPullJobForStep - that pairing is the thing this file exists to hold.
const GRIDS_FOR_PHASE: Record<string, Array<'productsGrid' | 'variationsGrid'>> = {
  PRODUCTS: ['productsGrid'],
  DELETIONS: ['productsGrid', 'variationsGrid'],
  VARIATIONS: ['variationsGrid'],
  DONE: [],
}

vi.mock('@/modules/google-sheet-products-for-shop/lib/pull-job', () => ({
  getPullJobLight: vi.fn(async () => {
    const { productsGrid: _p, variationsGrid: _v, ...light } = job
    return copy(light)
  }),
  getPullJobForStep: vi.fn(async () => {
    const allowed = GRIDS_FOR_PHASE[job.phase] ?? []
    const productsGrid = allowed.includes('productsGrid') ? copy(job.productsGrid) : null
    const variationsGrid = allowed.includes('variationsGrid') ? copy(job.variationsGrid) : null
    served.push({ phase: job.phase, productsGrid: productsGrid !== null, variationsGrid: variationsGrid !== null })
    return { ...copy({ ...job, productsGrid: null, variationsGrid: null }), productsGrid, variationsGrid }
  }),
  getPullJobStatus: vi.fn(async () => job.status),
  updatePullJob: vi.fn(async (_id: string, fields: Record<string, unknown>) => {
    if (swallowNextWrite) { swallowNextWrite = false; return }
    writeCount++
    if (job.status === 'CANCELLED') return
    const { clearGrids, ...rest } = fields as { clearGrids?: boolean }
    Object.assign(job, copy(rest))
    if (clearGrids) { job.productsGrid = null; job.variationsGrid = null }
  }),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    // Two raw statements reach here: the step lock's claim, and finalise's
    // atomic COMPLETED flip. Told apart by the statement itself, because getting
    // that wrong would let the flip stand in for the lock and the job would
    // "finish" before it had done anything.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings)
      if (sql.includes('step_lease_until')) return [{ step_lease_until: new Date(now) }]
      if (job.status === 'RUNNING') { job.status = 'COMPLETED'; job.phase = 'DONE'; return [{ id: job.id }] }
      return []
    }),
    $executeRaw: Object.assign(vi.fn(async () => 1), { catch: undefined }),
  },
}))

// --- the importers and passes, faked at shape and pace ----------------------

vi.mock('@/modules/shop/lib/import-engine', () => ({
  processImportJob: vi.fn(async (_id: string, csv: string) => {
    advance(4_500)
    for (const line of csv.split('\n').slice(1)) if (line.trim()) importedProductRows.push(line)
  }),
}))

vi.mock('@/modules/shop/lib/db/import-jobs', () => ({
  getImportJobById: vi.fn(async () => ({ errors: [], createdCount: 0, updatedCount: 0, skippedCount: 0 })),
  updateImportJobProgress: vi.fn(async () => {}),
}))

vi.mock('@/modules/shop-variations/lib/csv', () => ({
  importVariationsCsv: vi.fn(async (csv: string) => {
    advance(5_200)
    const rows = csv.split('\n').slice(1).filter((l) => l.trim())
    for (const r of rows) importedVariationRows.push(r)
    return { created: 0, updated: rows.length, errors: [] }
  }),
}))

// Pure enough to keep real would be nicer, but the engines above want a string
// and the shape is not what this file is testing.
vi.mock('@/modules/google-sheet-products-for-shop/lib/pull-products', () => ({
  gridToImportCsv: vi.fn((grid: string[][]) => grid.map((r) => r.join(',')).join('\n')),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/product-fields-pass', () => ({
  applyProductFieldsPass: vi.fn(async () => { advance(600); return { updated: 0, errors: [] } }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/description-puck-pass', () => ({
  applyDescriptionPuckPass: vi.fn(async () => { advance(500); return { updated: 0, errors: [] } }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/deletions', () => ({
  planPullDeletions: vi.fn(async () => { advance(2_000); return { products: [], variations: [] } }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/delete-pass', () => ({
  applyProductDeletions: vi.fn(async () => { advance(400); return { deleted: 0, errors: [] } }),
  applyVariationDeletions: vi.fn(async () => { advance(400); return { deleted: 0, errors: [] } }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/db', () => ({
  stampLastPull: vi.fn(async () => {}),
}))

import { stepPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-run'

async function runToCompletion(maxSteps = 200, stepCeilingMs = 60_000): Promise<{ steps: number; phases: string[] }> {
  const phases: string[] = []
  for (let i = 0; i < maxSteps; i++) {
    const before = now
    const status = await stepPullJob('pull-1', 'admin@example.com')
    phases.push(`${status?.phase}`)
    expect(now - before).toBeLessThan(stepCeilingMs)
    if (status?.done || status?.status === 'CANCELLED' || status?.status === 'FAILED') {
      return { steps: i + 1, phases }
    }
  }
  throw new Error(`the pull did not finish in ${maxSteps} steps`)
}

describe('the pull, driven step by step at a real catalogue size', () => {
  beforeEach(() => {
    now = 1_700_000_000_000
    job = freshJob()
    writeCount = 0
    swallowNextWrite = false
    served = []
    importedProductRows = []
    importedVariationRows = []
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('finishes, in more than one step and none of them unbounded', async () => {
    const startedAt = now
    const { steps, phases } = await runToCompletion()
    console.info(`[pull] ${steps} steps, ${Math.round((now - startedAt) / 1000)}s simulated, phases: ${phases.join(' → ')}`)

    expect(job.status).toBe('COMPLETED')
    expect(job.phase).toBe('DONE')
    expect(steps).toBeGreaterThan(3)
  })

  it('feeds every row through exactly once', async () => {
    await runToCompletion()

    expect(job.productsDone).toBe(PRODUCT_ROWS)
    expect(job.variationsDone).toBe(VARIATION_ROWS)
    expect(importedProductRows.length).toBe(PRODUCT_ROWS)
    expect(new Set(importedProductRows).size).toBe(PRODUCT_ROWS)
    expect(importedVariationRows.length).toBe(VARIATION_ROWS)
    expect(new Set(importedVariationRows).size).toBe(VARIATION_ROWS)
  })

  // The reason this file exists alongside the other two.
  it('serves each phase only the grid that phase imports', async () => {
    await runToCompletion()

    expect(served.length).toBeGreaterThan(3)
    for (const s of served) {
      expect(GRIDS_FOR_PHASE[s.phase], `phase ${s.phase} has no entry in the gate`).toBeDefined()
    }
    // Provides.
    expect(served.some((s) => s.phase === 'PRODUCTS' && s.productsGrid)).toBe(true)
    expect(served.some((s) => s.phase === 'VARIATIONS' && s.variationsGrid)).toBe(true)
    expect(served.filter((s) => s.phase === 'DELETIONS').every((s) => s.productsGrid && s.variationsGrid)).toBe(true)
    // And withholds - the half that saves the time.
    expect(served.filter((s) => s.phase === 'PRODUCTS').every((s) => !s.variationsGrid)).toBe(true)
    expect(served.filter((s) => s.phase === 'VARIATIONS').every((s) => !s.productsGrid)).toBe(true)
  })

  it('picks up where it left off when a step is killed before it can bank', async () => {
    await stepPullJob('pull-1', 'admin@example.com')
    swallowNextWrite = true
    await stepPullJob('pull-1', 'admin@example.com')

    await runToCompletion()
    expect(job.status).toBe('COMPLETED')
    expect(job.productsDone).toBe(PRODUCT_ROWS)
    expect(job.variationsDone).toBe(VARIATION_ROWS)
    // A redone chunk re-feeds rows, which is idempotent through the engines, but
    // every row must still have gone through and none may have been skipped.
    expect(new Set(importedProductRows).size).toBe(PRODUCT_ROWS)
    expect(new Set(importedVariationRows).size).toBe(VARIATION_ROWS)
  })

  it('stops when it is cancelled mid-run, and stays stopped', async () => {
    await stepPullJob('pull-1', 'admin@example.com')
    expect(job.status).toBe('RUNNING')

    job.status = 'CANCELLED'
    const after = await stepPullJob('pull-1', 'admin@example.com')
    expect(after?.status).toBe('CANCELLED')

    const writesBefore = writeCount
    await stepPullJob('pull-1', 'admin@example.com')
    await stepPullJob('pull-1', 'admin@example.com')
    expect(writeCount).toBe(writesBefore)
    expect(job.status).toBe('CANCELLED')
  })
})
