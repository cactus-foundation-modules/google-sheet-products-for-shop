import { describe, it, expect } from 'vitest'
import {
  planCapacity,
  targetRows,
  targetColumns,
  reclaimRowTarget,
  totalCells,
  CELL_BUDGET,
  WORKBOOK_CELL_LIMIT,
  MIN_ROWS,
  MIN_COLUMNS,
  type SheetGrid,
} from '@/modules/google-sheet-products-for-shop/lib/capacity'
import { resizeRequests } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import type { TabPushPlan } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import type { SheetCell } from '@/modules/google-sheet-products-for-shop/lib/sheets'

type ResizeRequest = {
  updateSheetProperties: {
    properties: { sheetId: number; gridProperties: { rowCount?: number; columnCount?: number } }
    fields: string
  }
}

const v = (value: string): SheetCell => ({ formula: null, value, error: false })
const row = (n: number): SheetCell[] => Array.from({ length: n }, () => v('x'))

function grid(sheetId: number, rowCount: number, columnCount: number): SheetGrid {
  return { sheetId, rowCount, columnCount }
}

function plan(over: Partial<TabPushPlan> & { tab: string }): TabPushPlan {
  return {
    insert: null,
    doomedRows: [],
    grid: [],
    preserved: [],
    clears: [],
    skip: false,
    ...over,
  }
}

describe('tab sizing', () => {
  it('gives a tab room to grow without handing it Google\'s blank default', () => {
    // A 40-variant product: 41 rows of content, not 1000. Under the floor, so it
    // gets the floor rather than the slack.
    expect(targetRows(41)).toBe(MIN_ROWS)
    expect(targetRows(200)).toBe(250)
    expect(targetColumns(20)).toBe(MIN_COLUMNS)
    // A tiny tab still gets a usable floor.
    expect(targetRows(2)).toBe(MIN_ROWS)
    // A big one is sized to fit, not to a fixed cap.
    expect(targetRows(21_400)).toBe(21_450)
    expect(targetColumns(45)).toBe(50)
  })

  it('costs a fraction of what Google\'s default costs', () => {
    // The shape that broke the live sheet: 349 product tabs averaging 60 variants.
    const before = 349 * 1000 * 45 // default rows, inflated to the width request
    const after = 349 * targetRows(61) * targetColumns(20)
    expect(before).toBeGreaterThan(WORKBOOK_CELL_LIMIT)
    expect(after).toBeLessThan(CELL_BUDGET / 5)
  })
})

describe('planCapacity', () => {
  const roomy: Record<string, SheetGrid> = { Products: grid(0, 1000, 26), Alpha: grid(1, 200, 26) }

  it('does nothing at all when the workbook has room', () => {
    const result = planCapacity({
      grids: roomy,
      existing: [{ title: 'Alpha', rows: 50 }],
      planned: [{ title: 'Beta', rows: 30, columns: 20 }],
    })
    expect(result.requests).toEqual([])
    expect(result.overBudget).toBe(false)
    expect(result.currentCells).toBe(totalCells(roomy))
  })

  it('reclaims the blank rows of tabs it owns when the new tabs would not fit', () => {
    // 400 tabs at Google's default 1000x45, holding 60 variants each.
    const grids: Record<string, SheetGrid> = {}
    const existing = []
    for (let i = 0; i < 400; i++) {
      grids[`Tab ${i}`] = grid(i + 1, 1000, 45)
      existing.push({ title: `Tab ${i}`, rows: 61 })
    }
    const result = planCapacity({
      grids,
      existing,
      planned: [{ title: 'New', rows: 61, columns: 20 }],
    })
    expect(result.currentCells).toBe(400 * 1000 * 45)
    expect(result.requests).toHaveLength(400)
    const first = result.requests[0] as ResizeRequest
    expect(first.updateSheetProperties.properties.gridProperties.rowCount).toBe(reclaimRowTarget(61))
    // Rows only - a reclaim has not read the tabs, so it cannot know where the
    // owner's own columns end and must not guess.
    expect(first.updateSheetProperties.fields).toBe('gridProperties.rowCount')
    expect(result.projectedCells).toBeLessThan(CELL_BUDGET)
    expect(result.overBudget).toBe(false)
  })

  it('never grows a tab that is already smaller than the reclaim target', () => {
    const grids: Record<string, SheetGrid> = {}
    const existing = []
    for (let i = 0; i < 400; i++) {
      grids[`Tab ${i}`] = grid(i + 1, 1000, 45)
      existing.push({ title: `Tab ${i}`, rows: 61 })
    }
    grids['Small'] = grid(999, 80, 26)
    existing.push({ title: 'Small', rows: 20 })
    const result = planCapacity({ grids, existing, planned: [{ title: 'New', rows: 10, columns: 10 }] })
    const touched = (result.requests as ResizeRequest[]).map((r) => r.updateSheetProperties.properties.sheetId)
    expect(touched).not.toContain(999)
  })

  it('says so plainly when even the reclaim does not make it fit', () => {
    // A workbook stuffed with tabs this module does not own, so nothing can be
    // reclaimed and the new tabs genuinely have nowhere to go.
    const grids: Record<string, SheetGrid> = { Theirs: grid(1, 200_000, 49) }
    const result = planCapacity({
      grids,
      existing: [],
      planned: Array.from({ length: 100 }, (_, i) => ({ title: `New ${i}`, rows: 61, columns: 20 })),
    })
    expect(result.requests).toEqual([])
    expect(result.overBudget).toBe(true)
    expect(result.projectedCells).toBeGreaterThan(CELL_BUDGET)
  })
})

describe('resizeRequests', () => {
  it('trims a default-sized tab down to what it uses', () => {
    const plans = [plan({ tab: 'Alpha', grid: Array.from({ length: 41 }, () => Array(20).fill('x')) })]
    const old: Record<string, SheetCell[][]> = { Alpha: Array.from({ length: 41 }, () => row(20)) }
    const requests = resizeRequests(plans, old, { Alpha: grid(7, 1000, 45) }) as ResizeRequest[]
    expect(requests).toHaveLength(1)
    expect(requests[0]!.updateSheetProperties).toMatchObject({
      properties: { sheetId: 7, gridProperties: { rowCount: targetRows(41), columnCount: targetColumns(20) } },
      fields: 'gridProperties.rowCount,gridProperties.columnCount',
    })
  })

  it('keeps the owner\'s own columns and rows, which the pre-read can see', () => {
    // The catalogue occupies 20 columns; the owner has three of their own beyond
    // it and notes forty rows below the last product. Both are in the read, so
    // both are inside the trim.
    const plans = [plan({ tab: 'Alpha', grid: Array.from({ length: 41 }, () => Array(20).fill('x')) })]
    const old: Record<string, SheetCell[][]> = {
      Alpha: [...Array.from({ length: 41 }, () => row(23)), ...Array.from({ length: 40 }, () => row(23))],
    }
    const requests = resizeRequests(plans, old, { Alpha: grid(7, 1000, 45) }) as ResizeRequest[]
    expect(requests[0]!.updateSheetProperties.properties.gridProperties).toEqual({
      rowCount: targetRows(81),
      columnCount: targetColumns(23),
    })
  })

  it('never grows a tab', () => {
    const plans = [plan({ tab: 'Alpha', grid: Array.from({ length: 41 }, () => Array(20).fill('x')) })]
    const old: Record<string, SheetCell[][]> = { Alpha: Array.from({ length: 41 }, () => row(20)) }
    // Already snug: the targets are bigger than the tab, so nothing is emitted.
    expect(resizeRequests(plans, old, { Alpha: grid(7, 50, 22) })).toEqual([])
  })

  it('accounts for the inserts and deletes queued ahead of it in the same batch', () => {
    // 30 rows are about to be deleted and 4 columns inserted, neither of which is
    // reflected in the sizes read before the batch.
    const plans = [plan({
      tab: 'Alpha',
      grid: Array.from({ length: 41 }, () => Array(24).fill('x')),
      doomedRows: Array.from({ length: 30 }, (_, i) => i + 41),
      insert: { at: 20, count: 4 },
    })]
    const old: Record<string, SheetCell[][]> = { Alpha: Array.from({ length: 71 }, () => row(20)) }
    const requests = resizeRequests(plans, old, { Alpha: grid(7, 120, 24) }) as ResizeRequest[]
    // Rows: 120 - 30 = 90 after the deletes, target 41 + slack = 91, so no shrink.
    // Columns: 24 + 4 = 28 after the insert, used 24, target 29 - no shrink either.
    expect(requests).toEqual([])
  })

  it('leaves a tab alone when the sheet no longer has it', () => {
    const plans = [plan({ tab: 'Gone', grid: [['a']] })]
    expect(resizeRequests(plans, {}, {})).toEqual([])
  })
})
