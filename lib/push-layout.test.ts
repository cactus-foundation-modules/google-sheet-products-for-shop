import { describe, it, expect } from 'vitest'
import {
  planDeletedSheetRows,
  planFullyBlankRows,
  removeRows,
  toDescendingRowRanges,
  ownerColumnStart,
  spliceBlankColumns,
  orderRowsLikeSheet,
  planFormulaPreservation,
} from '@/modules/google-sheet-products-for-shop/lib/formula-preserve'
import type { SheetCell, CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// `v` is a plain value cell, `f` a formula cell with its current result.
const v = (value: CellValue): SheetCell => ({ formula: null, value: String(value), error: false })
const f = (formula: string, value: CellValue): SheetCell => ({ formula, value: String(value), error: false })

const KEYS = [['sku'], ['slug']]
const HEADER = ['sku', 'slug', 'name', 'price']
const OWNS = (h: string) => HEADER.includes(h)
const header: CellValue[] = [...HEADER]

// Old sheet: three products, each with an owner "notes" column to the right.
const oldGrid: SheetCell[][] = [
  [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
  [v('S1'), v('p1'), v('One'), v('10'), v('keep-1')],
  [v('S2'), v('p2'), v('Two'), v('20'), v('keep-2')],
  [v('S3'), v('p3'), v('Three'), v('30'), v('keep-3')],
]

describe('ownerColumnStart', () => {
  const set = new Set(HEADER)
  it('finds the first owner-added column to the right', () => {
    expect(ownerColumnStart(['sku', 'slug', 'name', 'price', 'notes', 'more'], set, OWNS)).toBe(4)
  })
  it('ignores a relabelled/removed module column (owned, not the owner\'s)', () => {
    const owns = (h: string) => [...HEADER, 'cost_price'].includes(h)
    expect(ownerColumnStart(['sku', 'slug', 'name', 'price', 'cost_price', 'notes'], set, owns)).toBe(5)
  })
  it('returns -1 when the owner has added nothing', () => {
    expect(ownerColumnStart([...HEADER], set, OWNS)).toBe(-1)
  })
})

describe('spliceBlankColumns', () => {
  it('opens blank columns at the boundary in every row', () => {
    const grid = [[v('sku'), v('slug'), v('notes')], [v('A1'), v('a-1'), v('mine')]]
    const out = spliceBlankColumns(grid, 2, 2)
    expect(out[0]!.map((c) => c.value)).toEqual(['sku', 'slug', '', '', 'notes'])
    expect(out[1]!.map((c) => c.value)).toEqual(['A1', 'a-1', '', '', 'mine'])
  })
})

describe('toDescendingRowRanges', () => {
  it('merges contiguous rows and orders highest first', () => {
    // Bottom-up, so applying one delete never shifts the indices of the next.
    expect(toDescendingRowRanges([2, 3, 7])).toEqual([{ start: 7, end: 8 }, { start: 2, end: 4 }])
  })
  it('de-duplicates', () => {
    expect(toDescendingRowRanges([5, 5])).toEqual([{ start: 5, end: 6 }])
  })
})

describe('planDeletedSheetRows', () => {
  it('names the row of a product that has left the catalogue', () => {
    // P2 deleted in the admin: the rebuilt grid has only P1 and P3.
    const newGrid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S3', 'p3', 'Three', 30]]
    expect(planDeletedSheetRows({ oldGrid, newGrid, keyStrategies: KEYS })).toEqual([2])
  })

  it('deletes nothing when every product is still there', () => {
    const newGrid: CellValue[][] = [
      header, ['S1', 'p1', 'One', 10], ['S2', 'p2', 'Two', 20], ['S3', 'p3', 'Three', 30],
    ]
    expect(planDeletedSheetRows({ oldGrid, newGrid, keyStrategies: KEYS })).toEqual([])
  })

  it('does NOT delete a product whose SKU was cleared - the slug still matches', () => {
    // The priority key would read this as "S2 is gone"; matching on ANY identity
    // recognises it by slug and spares the row (and the owner's note on it).
    const newGrid: CellValue[][] = [
      header, ['S1', 'p1', 'One', 10], ['', 'p2', 'Two', 20], ['S3', 'p3', 'Three', 30],
    ]
    expect(planDeletedSheetRows({ oldGrid, newGrid, keyStrategies: KEYS })).toEqual([])
  })

  it('does NOT delete a product whose slug changed but SKU held', () => {
    const newGrid: CellValue[][] = [
      header, ['S1', 'p1', 'One', 10], ['S2', 'p2-renamed', 'Two', 20], ['S3', 'p3', 'Three', 30],
    ]
    expect(planDeletedSheetRows({ oldGrid, newGrid, keyStrategies: KEYS })).toEqual([])
  })

  it('never deletes a row with no usable identity (owner part-way through typing)', () => {
    const withDraft: SheetCell[][] = [
      ...oldGrid,
      [v(''), v(''), v('Half-typed product'), v('99'), v('')],
    ]
    const newGrid: CellValue[][] = [
      header, ['S1', 'p1', 'One', 10], ['S2', 'p2', 'Two', 20], ['S3', 'p3', 'Three', 30],
    ]
    expect(planDeletedSheetRows({ oldGrid: withDraft, newGrid, keyStrategies: KEYS })).toEqual([])
  })

  it('refuses to plan anything when the pushed columns do not line up', () => {
    const mismatched: SheetCell[][] = [
      [v('sku'), v('name'), v('slug'), v('price')], // name/slug swapped vs new
      [v('S1'), v('One'), v('p1'), v('10')],
    ]
    const newGrid: CellValue[][] = [header, ['S9', 'p9', 'Nine', 90]]
    expect(planDeletedSheetRows({ oldGrid: mismatched, newGrid, keyStrategies: KEYS })).toEqual([])
  })
})

describe('planFullyBlankRows', () => {
  it('finds a row that is blank across every column, pushed and owner\'s', () => {
    const grid: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      [v('S1'), v('p1'), v('One'), v('10'), v('keep-1')],
      // A v0.1.33 leftover: pushed cells blanked, owner's column also blank.
      [v(''), v(''), v(''), v(''), v('')],
      [v('S3'), v('p3'), v('Three'), v('30'), v('keep-3')],
    ]
    expect(planFullyBlankRows(grid)).toEqual([2])
  })

  it('leaves a row alone if the owner has anything at all on it', () => {
    const grid: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      // Pushed cells blank (product gone) but the owner's own note survives.
      [v(''), v(''), v(''), v(''), v('do not lose this')],
    ]
    expect(planFullyBlankRows(grid)).toEqual([])
  })

  it('leaves a row alone if it holds a formula, even one evaluating blank', () => {
    const grid: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price')],
      [v(''), v(''), v(''), f('=IF(FALSE,1,"")', '')],
    ]
    expect(planFullyBlankRows(grid)).toEqual([])
  })

  it('finds nothing on a fully populated sheet', () => {
    expect(planFullyBlankRows(oldGrid)).toEqual([])
  })
})

describe('the delete sweep merges identity-based deletions with the blank-row cleanup', () => {
  it('a Push plans both a deleted product\'s row and an unrelated leftover gap', () => {
    const withGap: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      [v('S1'), v('p1'), v('One'), v('10'), v('keep-1')],
      [v(''), v(''), v(''), v(''), v('')], // pure leftover gap - no identity, no content
      [v('S2'), v('p2'), v('Two'), v('20'), v('keep-2')],
      [v('S3'), v('p3'), v('Three'), v('30'), v('keep-3')],
    ]
    // P2 removed in the admin.
    const newGrid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S3', 'p3', 'Three', 30]]
    const doomed = [...new Set([
      ...planDeletedSheetRows({ oldGrid: withGap, newGrid, keyStrategies: KEYS }),
      ...planFullyBlankRows(withGap),
    ])]
    expect(doomed.sort((a, b) => a - b)).toEqual([2, 3]) // the gap, then P2's row
    // Adjacent rows, so they merge into one contiguous delete range.
    expect(toDescendingRowRanges(doomed)).toEqual([{ start: 2, end: 4 }])
  })
})

describe('after the row delete, the catalogue and the owner\'s columns line up', () => {
  it('survivors keep their order and their formulas', () => {
    const oldWithFormula: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      [v('S1'), v('p1'), v('One'), f('=5*2', 10), v('keep-1')],
      [v('S2'), v('p2'), v('Two'), v('20'), v('keep-2')],
      [v('S3'), v('p3'), v('Three'), f('=15*2', 30), v('keep-3')],
    ]
    const newGrid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S3', 'p3', 'Three', 30]]

    const doomed = planDeletedSheetRows({ oldGrid: oldWithFormula, newGrid, keyStrategies: KEYS })
    expect(doomed).toEqual([2]) // P2's row
    // Mirror the deleteDimension: the sheet now holds P1 then P3, and the owner's
    // "keep-3" note has moved up with P3's row.
    const afterDelete = removeRows(oldWithFormula, doomed)
    expect(afterDelete.map((r) => r[4]!.value)).toEqual(['notes', 'keep-1', 'keep-3'])

    const grid = orderRowsLikeSheet({ oldGrid: afterDelete, newGrid, keyStrategies: KEYS })
    expect(grid[1]).toEqual(['S1', 'p1', 'One', 10])
    expect(grid[2]).toEqual(['S3', 'p3', 'Three', 30]) // sits beside keep-3, as it should

    // Both survivors line up with their own old row, so both formulas survive.
    const preserved = planFormulaPreservation({ oldGrid: afterDelete, newGrid: grid, keyStrategies: KEYS })
    expect(preserved.map((p) => p.formula).sort()).toEqual(['=15*2', '=5*2'])
  })
})

describe('planFormulaPreservation tolerates a newly inserted blank column', () => {
  it('keeps prefix formulas when the grid widened (blank old column under a new one)', () => {
    // The state right after a widening insert: the old grid has been spliced with
    // a blank column where the new "colour" attribute now sits.
    const widened: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('')],
      [v('S1'), v('p1'), v('One'), f('=5*2', 10), v('')],
    ]
    const newGrid: CellValue[][] = [
      ['sku', 'slug', 'name', 'price', 'colour'],
      ['S1', 'p1', 'One', 10, 'red'],
    ]
    expect(planFormulaPreservation({ oldGrid: widened, newGrid, keyStrategies: KEYS }).map((p) => p.formula)).toEqual(['=5*2'])
  })
})
