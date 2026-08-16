import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PushJob, PushVariationTab } from '@/modules/google-sheet-products-for-shop/lib/types'

// Does a Push of a big catalogue actually FINISH, and does every phase get the
// snapshot it needs?
//
// The twin of preview-run.test.ts, and it exists for two reasons. The first is
// the same one: a Push is a stepped job against a sixty-second ceiling, and what
// is worth pinning down is the state machine - from a standing start, does
// calling /step repeatedly reach COMPLETED, in bounded steps, having written
// every tab exactly once, surviving a step the platform kills, and stopping when
// told to?
//
// The second is newer. The job row carries the whole catalogue snapshot, so it is
// no longer read whole: each step is served only the snapshot its own phase
// writes from (see getPushJobForStep). That gate is enforced in SQL, which no
// unit test can reach - so the fake below applies the SAME gate, and a phase that
// quietly started reading the other snapshot would fail here rather than in front
// of a customer, half way through writing their sheet.
//
// Everything below the stepper is faked (Google, the database, the grid builders)
// and the clock is simulated so the time budget genuinely bites. The numbers are
// Deskwell's: ~445 catalogue rows, ~349 variable products.
const PRODUCT_ROWS = 445
const TAB_COUNT = 349

let now = 1_700_000_000_000
const advance = (ms: number) => { now += ms }

// --- the in-memory job row, standing in for gsp_push_job --------------------

let job: PushJob
let writeCount = 0
let swallowNextWrite = false

// What each phase was actually served, recorded by the fake gate below. The
// assertions read this to prove the gate withholds as well as provides.
let served: Array<{ phase: string; productsGrid: boolean; variationTabs: boolean }> = []

function freshJob(): PushJob {
  return {
    id: 'push-1', status: 'RUNNING', phase: 'BUILD_PRODUCTS', force: false,
    productsGrid: null, variationTabs: null, writtenTitles: null,
    tabsTotal: 0, tabsDone: 0,
    productsRows: 0, variationsRows: 0, suppliersRows: 0, formulasKept: 0,
    error: null, runBy: 'admin', createdAt: new Date(now),
  }
}

const copy = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)) as T)

// Which snapshot each phase is entitled to. This MUST match the CASE arms in
// getPushJobForStep; that is the whole point of the file. If you add a phase
// there, add it here, and if the two disagree the tests below stop.
const SNAPSHOTS_FOR_PHASE: Record<string, Array<'productsGrid' | 'variationTabs'>> = {
  BUILD_PRODUCTS: [],
  BUILD_TABS: [],
  PRODUCTS: ['productsGrid'],
  VARIATION_TABS: ['variationTabs'],
  CLEANUP: ['variationTabs'],
  DONE: [],
}

vi.mock('@/modules/google-sheet-products-for-shop/lib/push-job', () => ({
  getPushJobLight: vi.fn(async () => {
    const { productsGrid: _p, variationTabs: _v, ...light } = job
    return light
  }),
  getPushJobForStep: vi.fn(async () => {
    const allowed = SNAPSHOTS_FOR_PHASE[job.phase] ?? []
    const productsGrid = allowed.includes('productsGrid') ? copy(job.productsGrid) : null
    const variationTabs = allowed.includes('variationTabs') ? copy(job.variationTabs) : null
    served.push({ phase: job.phase, productsGrid: productsGrid !== null, variationTabs: variationTabs !== null })
    return { ...job, productsGrid, variationTabs }
  }),
  getPushJobStatus: vi.fn(async () => job.status),
  updatePushJob: vi.fn(async (_id: string, fields: Record<string, unknown>) => {
    if (swallowNextWrite) { swallowNextWrite = false; return }
    writeCount++
    if (job.status === 'CANCELLED') return
    const { clearSnapshot, ...rest } = fields as { clearSnapshot?: boolean }
    Object.assign(job, copy(rest))
    if (clearSnapshot) { job.productsGrid = null; job.variationTabs = null }
  }),
  claimPushStepLease: vi.fn(async () => new Date(now)),
  releasePushStepLease: vi.fn(async () => {}),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      // The atomic COMPLETED flip. Must win exactly once.
      if (job.status === 'RUNNING') { job.status = 'COMPLETED'; job.phase = 'DONE'; return [{ id: job.id }] }
      return []
    }),
  },
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/db', () => ({
  getConnection: vi.fn(async () => ({
    spreadsheetId: 'sheet-1', includeStock: true, includeTradePrice: true,
    lastPushAt: null, lastPullAt: null, lastPushAttemptAt: null, variationTabManifest: null,
  })),
  stampLastPush: vi.fn(async () => {}),
  stampLastPushAttempt: vi.fn(async () => {}),
  setVariationTabManifest: vi.fn(async () => {}),
}))

// --- the catalogue builders, faked at Deskwell's shape and pace --------------

vi.mock('@/modules/google-sheet-products-for-shop/lib/push-products', () => ({
  buildProductsGrid: vi.fn(async () => {
    advance(19_000) // the catalogue load, measured live at about this
    return [['sku', 'name'], ...Array.from({ length: PRODUCT_ROWS }, (_, i) => [`SKU${i}`, `Product ${i}`])]
  }),
  pushProductsGrid: vi.fn(async () => { advance(12_000); return { rowCount: PRODUCT_ROWS, preservedFormulas: 3 } }),
}))

// Every tab written, in order, so the assertions can prove exactly-once.
let pushedTitles: string[] = []

vi.mock('@/modules/google-sheet-products-for-shop/lib/push-variations', () => ({
  buildVariationTabs: vi.fn(async () => {
    advance(21_000)
    return Array.from({ length: TAB_COUNT }, (_, i) => ({
      slug: `product-${i}`, name: `Product ${i}`,
      grid: [['Parent Slug', 'Option 1', 'Value 1'], [`product-${i}`, 'Size', 'Large']],
    }))
  }),
  pushVariationTabsBatch: vi.fn(async (_id: string, tabs: Array<{ title: string; grid: unknown[][] }>) => {
    advance(2_400)
    for (const t of tabs) pushedTitles.push(t.title)
    return tabs.map((t) => ({ rowCount: t.grid.length - 1, preservedFormulas: 0 }))
  }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/push-supplier-catalogues', () => ({
  pushSuppliersTab: vi.fn(async () => { advance(1_500); return { rowCount: 12 } }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/workbook', () => ({
  createVariationTabsBatch: vi.fn(async (_id: string, planned: Array<{ title: string }>, existing: number[]) => {
    advance(1_200)
    let next = existing.length + 100
    return Object.fromEntries(planned.map((p) => [p.title, next++]))
  }),
  orderTabs: vi.fn(async () => { advance(900) }),
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/google-sheet-products-for-shop/lib/sheets')>()
  return {
    ...actual,
    // An empty workbook: every product tab is genuinely new, which is the path
    // that has to create tabs and check capacity.
    getSheetGrids: vi.fn(async () => { advance(1_800); return { Products: { sheetId: 0, rowCount: 1000, columnCount: 30 } } }),
    getSheetIds: vi.fn(async () => { advance(400); return { Products: 0, Suppliers: 1 } }),
    getSheetModifiedTime: vi.fn(async () => { advance(300); return new Date(now) }),
    readHeaderRows: vi.fn(async () => { advance(600); return {} }),
    deleteSheets: vi.fn(async () => { advance(500) }),
    batchUpdate: vi.fn(async () => { advance(700) }),
  }
})

// Capacity is its own concern with its own tests; this file is about the state
// machine, so the workbook is simply big enough.
vi.mock('@/modules/google-sheet-products-for-shop/lib/capacity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/google-sheet-products-for-shop/lib/capacity')>()
  return { ...actual, planCapacity: vi.fn(() => ({ requests: [], overBudget: false })) }
})

vi.mock('@/modules/google-sheet-products-for-shop/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

import { stepPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-run'

async function runToCompletion(maxSteps = 200, stepCeilingMs = 60_000): Promise<{ steps: number; phases: string[] }> {
  const phases: string[] = []
  for (let i = 0; i < maxSteps; i++) {
    const before = now
    const status = await stepPushJob('push-1')
    phases.push(`${status?.phase}`)
    // No step may run past the platform's ceiling. That is the fault the whole
    // stepped design exists to avoid, so it is asserted on every step.
    expect(now - before).toBeLessThan(stepCeilingMs)
    if (status?.done || status?.status === 'CANCELLED' || status?.status === 'FAILED') {
      return { steps: i + 1, phases }
    }
  }
  throw new Error(`the push did not finish in ${maxSteps} steps`)
}

describe('the push, driven step by step at a real catalogue size', () => {
  beforeEach(() => {
    now = 1_700_000_000_000
    job = freshJob()
    writeCount = 0
    swallowNextWrite = false
    pushedTitles = []
    served = []
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('finishes, in more than one step and none of them unbounded', async () => {
    const startedAt = now
    const { steps, phases } = await runToCompletion()
    console.info(`[push] ${steps} steps, ${Math.round((now - startedAt) / 1000)}s simulated, phases: ${phases.join(' → ')}`)

    expect(job.status).toBe('COMPLETED')
    expect(job.phase).toBe('DONE')
    // Several steps. One step doing the lot would mean the budget is not honoured.
    expect(steps).toBeGreaterThan(5)
  })

  it('writes every product tab exactly once', async () => {
    await runToCompletion()

    expect(job.tabsDone).toBe(TAB_COUNT)
    expect(pushedTitles.length).toBe(TAB_COUNT)
    expect(new Set(pushedTitles).size).toBe(TAB_COUNT) // no tab written twice
    expect(job.writtenTitles?.length).toBe(TAB_COUNT)
    expect(job.productsRows).toBe(PRODUCT_ROWS)
  })

  // The reason this file exists. The row is no longer read whole, so each phase
  // must be handed exactly the snapshot it writes from - no more, and no less.
  it('serves each phase only the snapshot that phase writes from', async () => {
    await runToCompletion()

    expect(served.length).toBeGreaterThan(5)
    for (const s of served) {
      expect(SNAPSHOTS_FOR_PHASE[s.phase], `phase ${s.phase} has no entry in the gate`).toBeDefined()
    }
    // The gate provides.
    expect(served.some((s) => s.phase === 'PRODUCTS' && s.productsGrid)).toBe(true)
    expect(served.some((s) => s.phase === 'VARIATION_TABS' && s.variationTabs)).toBe(true)
    expect(served.some((s) => s.phase === 'CLEANUP' && s.variationTabs)).toBe(true)
    // And, the half that actually saves the time, it withholds.
    expect(served.filter((s) => s.phase === 'PRODUCTS').every((s) => !s.variationTabs)).toBe(true)
    expect(served.filter((s) => s.phase === 'VARIATION_TABS').every((s) => !s.productsGrid)).toBe(true)
    expect(served.filter((s) => s.phase === 'CLEANUP').every((s) => !s.productsGrid)).toBe(true)
    expect(served.filter((s) => s.phase === 'BUILD_PRODUCTS' || s.phase === 'BUILD_TABS')
      .every((s) => !s.productsGrid && !s.variationTabs)).toBe(true)
  })

  it('picks up where it left off when a step is killed before it can bank', async () => {
    await stepPushJob('push-1') // BUILD_PRODUCTS
    await stepPushJob('push-1') // BUILD_TABS
    await stepPushJob('push-1') // PRODUCTS
    swallowNextWrite = true     // a killed request: work done, bank lost
    await stepPushJob('push-1')

    await runToCompletion()
    expect(job.status).toBe('COMPLETED')
    expect(job.tabsDone).toBe(TAB_COUNT)
    // A redone group re-writes the same tabs, which is safe and idempotent, but
    // every tab must still be present and the cursor must not have skipped any.
    expect(new Set(pushedTitles).size).toBe(TAB_COUNT)
    expect(new Set(job.writtenTitles).size).toBe(TAB_COUNT)
  })

  it('stops when it is cancelled mid-run, and stays stopped', async () => {
    await stepPushJob('push-1')
    await stepPushJob('push-1')
    expect(job.status).toBe('RUNNING')

    job.status = 'CANCELLED'
    const after = await stepPushJob('push-1')
    expect(after?.status).toBe('CANCELLED')

    const writesBefore = writeCount
    await stepPushJob('push-1')
    await stepPushJob('push-1')
    expect(writeCount).toBe(writesBefore)
    expect(job.status).toBe('CANCELLED')
  })
})
