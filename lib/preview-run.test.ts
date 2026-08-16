import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PreviewJob } from '@/modules/google-sheet-products-for-shop/lib/types'

// Does a check of a big sheet actually FINISH?
//
// That is the fault this whole rework exists to fix: "Reading your sheet and
// comparing it with your catalogue…" sat there for ever, because the work was one
// request against a sixty-second ceiling. It is now a stepped job, and the thing
// worth pinning down is not any single function but the state machine: from a
// standing start, does calling /step repeatedly reach COMPLETED - in bounded
// steps, having compared every row exactly once, surviving a step the platform
// kills, and stopping when told to?
//
// Everything below the stepper is faked (Google, the database, the diff), and the
// clock is simulated so the time budget genuinely bites - a fake that answered
// instantly would let one step swallow the lot and prove nothing about bounding.
// The numbers are Deskwell's: ~383 tabs, ~450 catalogue rows, ~350 variable
// parents.

const TAB_COUNT = 383
const PRODUCT_ROWS = 450
const PARENT_COUNT = 350

// Simulated wall clock. Every faked unit of work advances it, so the runner's own
// budget checks behave exactly as they would against a slow sheet.
let now = 1_700_000_000_000
const advance = (ms: number) => { now += ms }

// What the products phase's setup costs. Live, this was measured at 150 seconds
// against a 30-second budget, which is what "Products compared - 0 of 445" was:
// the loop asked whether there was budget left before its first pass, there never
// was, and every step repeated the same setup to achieve the same nothing. One
// test below turns this up past the budget deliberately.
let productSetupCostMs = 2_000

// Set to make the NEXT products chunk throw, standing in for the database being
// briefly out of reach mid-check. Cleared as it fires, so exactly one chunk fails.
let failNextProductChunk: Error | null = null

// --- the in-memory job row, standing in for gsp_preview_job -----------------

let job: PreviewJob
let writeCount = 0
// Set to drop the next write on the floor, standing in for a step the platform
// kills after it has done its work but before it can bank.
let swallowNextWrite = false

function freshJob(): PreviewJob {
  return {
    id: 'job-1', status: 'RUNNING', phase: 'READ',
    tabTitles: null, tabsTotal: 0, tabsDone: 0, rawTabs: null, driveModifiedTime: null,
    productsGrid: null, variationsGrid: null,
    productsTotal: 0, productsDone: 0, variationsTotal: 0, variationsDone: 0,
    currentItem: null, preview: null,
    filteredProducts: null, productsRowMap: null, filteredVariations: null, variationsRowMap: null,
    deletionPlan: null, detected: null, lastPushAt: null,
    error: null, fatal: false, runBy: 'admin', createdAt: new Date(now), updatedAt: new Date(now),
  }
}

// Reads and writes go through a copy, exactly as a jsonb column does. Sharing
// the object instead would let a step keep mutating what it had already banked,
// so a resumed step would resume from state it was never given - the one thing a
// fake database must not get wrong, since resuming is what is under test.
const copy = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)) as T)

vi.mock('@/modules/google-sheet-products-for-shop/lib/preview-job', () => ({
  getPreviewJob: vi.fn(async () => ({ ...job, preview: copy(job.preview), rawTabs: copy(job.rawTabs) })),
  getPreviewJobStatus: vi.fn(async () => job.status),
  updatePreviewJob: vi.fn(async (_id: string, fields: Record<string, unknown>) => {
    if (swallowNextWrite) { swallowNextWrite = false; return }
    writeCount++
    if (job.status === 'CANCELLED') return // the real one refuses to write to a cancelled job
    const { clearWorking, ...rest } = fields as { clearWorking?: boolean }
    Object.assign(job, copy(rest))
    if (clearWorking) { job.rawTabs = null; job.productsGrid = null; job.variationsGrid = null }
  }),
  claimPreviewStepLease: vi.fn(async () => new Date(now)),
  releasePreviewStepLease: vi.fn(async () => {}),
  // Says "still alive" before a long setup. Writes nothing else, so the fake can
  // be a no-op - but it must EXIST, or every step dies on an undefined call.
  heartbeatPreviewJob: vi.fn(async () => {}),
}))

// The finalise claim is the one place the runner reaches for raw SQL directly.
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      // Either the staleness count or the atomic COMPLETED flip, told apart by
      // what the runner does with the answer. The flip must win exactly once.
      if (job.status === 'RUNNING' && job.phase === 'DONE') {
        job.status = 'COMPLETED'
        return [{ id: job.id }]
      }
      return [{ count: 0n }]
    }),
  },
}))

vi.mock('@/modules/google-sheet-products-for-shop/lib/db', () => ({
  getConnection: vi.fn(async () => ({
    spreadsheetId: 'sheet-1', includeStock: true, includeTradePrice: true,
    lastPushAt: null, variationTabManifest: null,
  })),
}))

// --- Google, faked at Deskwell's shape and pace -----------------------------

const productTabTitles = Array.from({ length: TAB_COUNT }, (_, i) => `Product ${i + 1}`)

vi.mock('@/modules/google-sheet-products-for-shop/lib/sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/google-sheet-products-for-shop/lib/sheets')>()
  return {
    ...actual,
    getSheetModifiedTime: vi.fn(async () => { advance(300); return new Date(now) }),
    getSheetIds: vi.fn(async () => {
      advance(400)
      return Object.fromEntries([['Products', 0], ['Suppliers', 1], ['Read me', 2],
        ...productTabTitles.map((t, i) => [t, i + 3])])
    }),
    readGrid: vi.fn(async () => {
      advance(900)
      // The real header, so the runner's "is this sheet usable at all" check
      // passes and the check goes on to actually compare things. A short header
      // would be reported as missing columns and the job would stop at DONE -
      // which is correct behaviour, and not what this test is about.
      const { CSV_COLUMNS } = await import('@/modules/shop/lib/csv')
      const header = [...CSV_COLUMNS] as string[]
      const at = (c: string, i: number) =>
        c === 'sku' ? `SKU${i}` : c === 'slug' ? `product-${i}` : c === 'name' ? `Product ${i}`
        : c === 'type' ? 'PHYSICAL' : c === 'status' ? 'ACTIVE' : c === 'price' ? '10' : ''
      return [header, ...Array.from({ length: PRODUCT_ROWS }, (_, i) => header.map((c) => at(c, i)))]
    }),
    // One batched call per group of tabs, and it is not free - this is the pace
    // that used to blow the ceiling before the reads were spread over steps.
    readHeaderRows: vi.fn(async (_id: string, tabs: string[]) => {
      advance(1_100)
      return Object.fromEntries(tabs.map((t) => [t, ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Price']]))
    }),
    readGridsBatch: vi.fn(async (_id: string, tabs: string[]) => {
      advance(1_400)
      return Object.fromEntries(tabs.map((t, i) => [t, [
        ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Price'],
        [`product-${i}`, 'Size', 'Large', `child-${t}`, '10'],
      ]]))
    }),
  }
})

// --- the diff, faked: real shape, simulated cost ----------------------------

vi.mock('@/modules/google-sheet-products-for-shop/lib/pull-diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/google-sheet-products-for-shop/lib/pull-diff')>()
  return {
    ...actual, // keptRowsFromResults is pure and stays real
    prepareProductDiff: vi.fn(async (grid: string[][]) => {
      advance(productSetupCostMs) // the catalogue load - the setup a step pays before it can compare anything
      return { grid, rowCount: Math.max(grid.length - 1, 0) }
    }),
    diffProductRowRange: vi.fn(async (ctx: { grid: string[][] }, from: number, to: number) => {
      advance(1_500)
      if (failNextProductChunk) { const e = failNextProductChunk; failNextProductChunk = null; throw e }
      const out = []
      for (let r = from; r < Math.min(to, ctx.grid.length); r++) {
        // Every third row has work in it, so the filtered grid is a real subset.
        out.push(r % 3 === 0
          ? { row: r, kind: 'update' as const, sku: `SKU${r}`, name: `Product ${r}`, changes: [{ field: 'price', from: '9', to: '10' }] }
          : { row: r, kind: 'unchanged' as const, sku: `SKU${r}`, name: `Product ${r}` })
      }
      return out
    }),
    prepareVariationDiff: vi.fn(async () => {
      advance(2_000)
      return {
        groups: Array.from({ length: PARENT_COUNT }, (_, i) => ({
          slug: `product-${i}`, rows: [{ row: i + 1, cols: [] }],
        })),
        preErrors: [],
      }
    }),
    diffVariationGroupRange: vi.fn(async (ctx: { groups: Array<{ rows: Array<{ row: number }> }> }, from: number, to: number) => {
      advance(1_800)
      const out = []
      for (let g = from; g < Math.min(to, ctx.groups.length); g++) {
        for (const row of ctx.groups[g]!.rows) {
          out.push(g % 2 === 0
            ? { row: row.row, kind: 'update' as const, parentName: `Product ${g}`, label: 'Large' }
            : { row: row.row, kind: 'unchanged' as const })
        }
      }
      return out
    }),
  }
})

vi.mock('@/modules/google-sheet-products-for-shop/lib/deletions', () => ({
  planPullDeletions: vi.fn(async () => { advance(2_500); return { products: [], variations: [] } }),
}))

vi.mock('@/modules/shop-variations/lib/db/variants', () => ({
  getProductIdsWithVariations: vi.fn(async () => []),
}))

import { stepPreviewJob } from '@/modules/google-sheet-products-for-shop/lib/preview-run'

// Drive the job the way the browser does, and record what each step achieved.
async function runToCompletion(maxSteps = 200, stepCeilingMs = 40_000): Promise<{ steps: number; phases: string[] }> {
  const phases: string[] = []
  for (let i = 0; i < maxSteps; i++) {
    const before = now
    const status = await stepPreviewJob('job-1')
    phases.push(`${status?.phase}`)
    // No step may run past the dispatcher's ceiling. The budget is 30s; the
    // slowest single unit of faked work is ~2.5s, so 40s is a generous default
    // that still fails loudly if a phase ever stops checking the clock. The
    // slow-setup test raises it to the platform's real 60s limit, which is the
    // figure that actually matters there.
    expect(now - before).toBeLessThan(stepCeilingMs)
    if (status?.done || status?.status === 'CANCELLED' || status?.status === 'FAILED') {
      return { steps: i + 1, phases }
    }
  }
  throw new Error(`the check did not finish in ${maxSteps} steps - this is the original bug`)
}

describe('the sheet check, driven step by step at a real catalogue size', () => {
  beforeEach(() => {
    now = 1_700_000_000_000
    productSetupCostMs = 2_000
    failNextProductChunk = null
    job = freshJob()
    writeCount = 0
    swallowNextWrite = false
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('finishes, in more than one step and none of them unbounded', async () => {
    const startedAt = now
    const { steps, phases } = await runToCompletion()
    // Printed on purpose: when this test is the evidence that a big sheet gets
    // checked at all, the shape of the run is the evidence, not the green tick.
    console.info(`[check] ${steps} steps, ${Math.round((now - startedAt) / 1000)}s simulated, phases: ${phases.join(' → ')}`)

    expect(job.status).toBe('COMPLETED')
    expect(job.phase).toBe('DONE')
    // The point of the exercise: it took several steps. One step doing everything
    // would mean the budget is not being honoured, which is the old bug wearing a
    // new coat.
    expect(steps).toBeGreaterThan(3)
  })

  it('reads every tab and compares every row exactly once', async () => {
    await runToCompletion()

    expect(job.tabsDone).toBe(TAB_COUNT)
    expect(job.productsDone).toBe(PRODUCT_ROWS)
    expect(job.variationsDone).toBe(PARENT_COUNT)

    const p = job.preview!.products
    const v = job.preview!.variations
    // Every product row landed in exactly one bucket, and no row was counted twice.
    expect(p.toUpdateTotal + p.unchanged + p.toCreateTotal + p.rowErrorsTotal).toBe(PRODUCT_ROWS)
    expect(v.toUpdateTotal + v.unchanged + v.toCreate + v.rowErrorsTotal).toBe(PARENT_COUNT)
  })

  it('hands the Pull a filtered grid whose row map lines up with it', async () => {
    await runToCompletion()

    // Header + one row per changed product, and one sheet row number per data row.
    expect(job.filteredProducts!.length - 1).toBe(job.productsRowMap!.length)
    expect(job.filteredVariations!.length - 1).toBe(job.variationsRowMap!.length)
    // And it really is a subset - the whole point of skipping unchanged rows.
    expect(job.filteredProducts!.length - 1).toBeLessThan(PRODUCT_ROWS)

    expect(job.detected).toMatchObject({
      productsUpdate: job.preview!.products.toUpdateTotal,
      productsUnchanged: job.preview!.products.unchanged,
    })
  })

  it('picks up where it left off when a step is killed before it can bank', async () => {
    // Two steps in, drop a write on the floor exactly as a killed request would.
    await stepPreviewJob('job-1')
    await stepPreviewJob('job-1')
    swallowNextWrite = true
    await stepPreviewJob('job-1')

    const { steps } = await runToCompletion()
    expect(steps).toBeGreaterThan(0)
    expect(job.status).toBe('COMPLETED')
    // Nothing lost and nothing double-counted despite the dropped write.
    expect(job.tabsDone).toBe(TAB_COUNT)
    expect(job.productsDone).toBe(PRODUCT_ROWS)
    expect(job.variationsDone).toBe(PARENT_COUNT)
    const p = job.preview!.products
    expect(p.toUpdateTotal + p.unchanged + p.toCreateTotal + p.rowErrorsTotal).toBe(PRODUCT_ROWS)
  })

  it('stops when it is cancelled mid-run, and stays stopped', async () => {
    await stepPreviewJob('job-1')
    await stepPreviewJob('job-1')
    expect(job.status).toBe('RUNNING')

    job.status = 'CANCELLED'
    const after = await stepPreviewJob('job-1')
    expect(after?.status).toBe('CANCELLED')

    // Further steps do nothing at all - no work, no writes.
    const writesBefore = writeCount
    await stepPreviewJob('job-1')
    await stepPreviewJob('job-1')
    expect(writeCount).toBe(writesBefore)
    expect(job.status).toBe('CANCELLED')
  })

  // The regression test for the live fault. Chris's dialog sat on "Products
  // compared - 0 of 445" while the clock ran, because the phase's setup had grown
  // past the step budget and the compare loop was never entered. A step must
  // land at least one chunk when there is still room in the request to land it.
  it('still makes progress when the setup outlasts the step budget but fits the request', async () => {
    productSetupCostMs = 30_000 // past the 20s budget, still inside the 60s ceiling

    const { steps } = await runToCompletion(400, 60_000)

    expect(job.status).toBe('COMPLETED')
    // The bar moved off zero and reached the end - the phase was not merely slow,
    // it finished. Before the guarantee this looped for ever at productsDone 0.
    expect(job.productsDone).toBe(PRODUCT_ROWS)
    expect(job.variationsDone).toBe(PARENT_COUNT)
    expect(steps).toBeGreaterThan(3)
    const p = job.preview!.products
    expect(p.toUpdateTotal + p.unchanged + p.toCreateTotal + p.rowErrorsTotal).toBe(PRODUCT_ROWS)
  })

  // The other side of that contract. If setup eats so much of the request that a
  // chunk could not possibly land its cursor, starting one anyway just gets the
  // step killed mid-work - so it stops and SAYS so. Silence here is what a wedged
  // job looks like from the outside, and that is the thing to never ship again.
  it('fails loudly rather than looping when the setup leaves no room at all', async () => {
    productSetupCostMs = 50_000 // past the ceiling less its margin: no room for a chunk

    // Step until it gives up, however many steps the read takes first.
    let status = await stepPreviewJob('job-1')
    for (let i = 0; i < 20 && status?.status !== 'FAILED'; i++) status = await stepPreviewJob('job-1')

    expect(status?.status).toBe('FAILED')
    expect(status?.error).toMatch(/no time left to compare/i)
    expect(job.productsDone).toBe(0)
  })

  it('carries on from its cursor after being stopped part-way', async () => {
    // Step until the products compare has actually banked something, however
    // many steps that takes - the chunk sizes are tuning, not contract.
    for (let i = 0; i < 20 && job.productsDone === 0; i++) await stepPreviewJob('job-1')
    const stoppedAt = job.productsDone
    expect(stoppedAt).toBeGreaterThan(0)
    const gridsBefore = job.productsGrid

    // Exactly what the idle sweep now does: mark it stopped, keep everything.
    job.status = 'FAILED'
    job.error = 'The check stopped part-way through.'

    // Its place and its working copy both survive - the two things that made the
    // live one unrecoverable when the sweep cancelled and gutted it instead.
    expect(job.productsDone).toBe(stoppedAt)
    expect(job.productsGrid).toBe(gridsBefore)

    // Stepping it again picks up rather than restarting.
    const next = await stepPreviewJob('job-1')
    expect(next?.productsDone).toBeGreaterThanOrEqual(stoppedAt)
    expect(next?.tabsDone).toBe(TAB_COUNT) // the read is not done twice

    const { steps } = await runToCompletion()
    expect(steps).toBeGreaterThan(0)
    expect(job.status).toBe('COMPLETED')
    expect(job.productsDone).toBe(PRODUCT_ROWS)
    const p = job.preview!.products
    // Nothing counted twice by the resume.
    expect(p.toUpdateTotal + p.unchanged + p.toCreateTotal + p.rowErrorsTotal).toBe(PRODUCT_ROWS)
  })

  // The live failure: a pooler refused a connection mid-check and three and a
  // half minutes of completed work went in the bin. A blip must cost the chunk it
  // interrupted and nothing else - not the run, and not the owner's patience with
  // a wall of Prisma.
  it('survives a database blip and still completes, counting every row once', async () => {
    // Get as far as the products compare, then make its next chunk hit a database
    // that is briefly out of reach.
    for (let i = 0; i < 20 && job.phase !== 'PRODUCTS'; i++) await stepPreviewJob('job-1')
    expect(job.phase).toBe('PRODUCTS')

    failNextProductChunk = new Error("Can't reach database server at `db.example:6432`")
    const afterBlip = await stepPreviewJob('job-1')

    expect(afterBlip?.status).toBe('FAILED')
    // NOT fatal: the browser is meant to keep asking, which is the whole fix.
    expect(afterBlip?.fatal).toBe(false)
    // And what the owner reads is a sentence, not a hostname and a port.
    expect(afterBlip?.error).not.toMatch(/6432|prisma|queryRaw/i)
    expect(afterBlip?.error).toMatch(/nothing has been lost/i)

    // Carrying on finishes the job, with every row counted exactly once - the
    // failed chunk is redone, not skipped and not double-counted.
    const { steps } = await runToCompletion()
    expect(steps).toBeGreaterThan(0)
    expect(job.status).toBe('COMPLETED')
    expect(job.productsDone).toBe(PRODUCT_ROWS)
    expect(job.variationsDone).toBe(PARENT_COUNT)
    const p = job.preview!.products
    expect(p.toUpdateTotal + p.unchanged + p.toCreateTotal + p.rowErrorsTotal).toBe(PRODUCT_ROWS)
  })

  it('writes the heavy columns a handful of times, not once per chunk', async () => {
    await runToCompletion()
    // The accumulating grids are banked on a clock, not after every chunk. With
    // ~10 tab groups, 9 product chunks and 30 parent chunks, a write per chunk
    // would be ~50; banked, it is a fraction of that. Generous ceiling - the
    // assertion is about the order of magnitude, not the exact figure.
    expect(writeCount).toBeLessThan(60)
  })
})
