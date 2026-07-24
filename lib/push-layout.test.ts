import { describe, it, expect } from 'vitest'
import {
  layoutRowsAtSheetPositions,
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
// Header + a trailing owner column ("notes") the module does not own.
const HEADER = ['sku', 'slug', 'name', 'price']
const OWNS = (h: string) => HEADER.includes(h)

describe('ownerColumnStart', () => {
  const set = new Set(HEADER)
  it('finds the first owner-added column to the right', () => {
    const old = ['sku', 'slug', 'name', 'price', 'notes', 'more'].map((h) => h)
    expect(ownerColumnStart(old, set, OWNS)).toBe(4)
  })
  it('ignores a relabelled/removed module column (owned, not the owner\'s)', () => {
    // "cost_price" is a module column that has been switched off this push; it is
    // not in the new header, but it is ours, so it is not an owner column.
    const owns = (h: string) => [...HEADER, 'cost_price'].includes(h)
    const old = ['sku', 'slug', 'name', 'price', 'cost_price', 'notes']
    expect(ownerColumnStart(old, set, owns)).toBe(5)
  })
  it('returns -1 when the owner has added nothing', () => {
    expect(ownerColumnStart([...HEADER], set, OWNS)).toBe(-1)
  })
})

describe('spliceBlankColumns', () => {
  it('opens blank columns at the boundary in every row', () => {
    const grid = [
      [v('sku'), v('slug'), v('notes')],
      [v('A1'), v('a-1'), v('mine')],
    ]
    const out = spliceBlankColumns(grid, 2, 2)
    expect(out[0]!.map((c) => c.value)).toEqual(['sku', 'slug', '', '', 'notes'])
    expect(out[1]!.map((c) => c.value)).toEqual(['A1', 'a-1', '', '', 'mine'])
  })
})

describe('layoutRowsAtSheetPositions', () => {
  // Old sheet: three products, each with an owner "notes" column to the right.
  const oldGrid: SheetCell[][] = [
    [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
    [v('S1'), v('p1'), v('One'), v('10'), v('keep-1')],
    [v('S2'), v('p2'), v('Two'), v('20'), v('keep-2')],
    [v('S3'), v('p3'), v('Three'), v('30'), v('keep-3')],
  ]
  const header: CellValue[] = ['sku', 'slug', 'name', 'price']

  it('holds survivors at their sheet row and blanks the deleted one', () => {
    // P2 deleted: the new grid (from the DB) has only P1 and P3.
    const newGrid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S3', 'p3', 'Three', 30]]
    const laid = layoutRowsAtSheetPositions({ oldGrid, newGrid, keyStrategies: KEYS })!
    expect(laid).not.toBeNull()
    // P1 stays row 1, P2's row is blank, P3 stays row 3 - so the owner's notes
    // column (untouched by the pushed grid) still lines up with the right product.
    expect(laid[1]).toEqual(['S1', 'p1', 'One', 10])
    expect(laid[2]).toEqual(['', '', '', '']) // P2's vacated row
    expect(laid[3]).toEqual(['S3', 'p3', 'Three', 30])
    expect(laid.length).toBe(4)
  })

  it('by contrast, the compacting layout shifts P3 up (the bug this avoids)', () => {
    const newGrid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S3', 'p3', 'Three', 30]]
    const compact = orderRowsLikeSheet({ oldGrid, newGrid, keyStrategies: KEYS })
    // P3 lands on row 2, where the owner's "keep-2" note still sits - misaligned.
    expect(compact[2]).toEqual(['S3', 'p3', 'Three', 30])
  })

  it('appends genuinely new products after the last existing row', () => {
    const newGrid: CellValue[][] = [
      header, ['S1', 'p1', 'One', 10], ['S2', 'p2', 'Two', 20], ['S3', 'p3', 'Three', 30], ['S4', 'p4', 'Four', 40],
    ]
    const laid = layoutRowsAtSheetPositions({ oldGrid, newGrid, keyStrategies: KEYS })!
    expect(laid[1]).toEqual(['S1', 'p1', 'One', 10])
    expect(laid[3]).toEqual(['S3', 'p3', 'Three', 30])
    expect(laid[4]).toEqual(['S4', 'p4', 'Four', 40]) // new, at the bottom
  })

  it('preserves a survivor\'s formula because it never moves', () => {
    const oldWithFormula: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      [v('S1'), v('p1'), v('One'), f('=5*2', 10), v('keep-1')],
      [v('S2'), v('p2'), v('Two'), v('20'), v('keep-2')],
      [v('S3'), v('p3'), v('Three'), f('=15*2', 30), v('keep-3')],
    ]
    const newGrid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S3', 'p3', 'Three', 30]]
    const laid = layoutRowsAtSheetPositions({ oldGrid: oldWithFormula, newGrid, keyStrategies: KEYS })!
    const preserved = planFormulaPreservation({ oldGrid: oldWithFormula, newGrid: laid, keyStrategies: KEYS })
    // Both survivors kept their row, so both formulas survive (=15*2 would have
    // been dropped by the compacting layout, which shifts P3 to row 2).
    expect(preserved.map((p) => p.formula).sort()).toEqual(['=15*2', '=5*2'])
  })

  it('returns null when the pushed columns do not line up (caller falls back)', () => {
    const mismatched: SheetCell[][] = [
      [v('sku'), v('name'), v('slug'), v('price')], // name/slug swapped vs new
      [v('S1'), v('One'), v('p1'), v('10')],
    ]
    const newGrid: CellValue[][] = [['sku', 'slug', 'name', 'price'], ['S1', 'p1', 'One', 10]]
    expect(layoutRowsAtSheetPositions({ oldGrid: mismatched, newGrid, keyStrategies: KEYS })).toBeNull()
  })
})

describe('planFormulaPreservation tolerates a newly inserted blank column', () => {
  it('keeps prefix formulas when the grid widened (blank old column under a new one)', () => {
    // Simulates the state right after a widening insert: the old grid has been
    // spliced with a blank column where the new "colour" attribute now sits.
    const oldGrid: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('')],
      [v('S1'), v('p1'), v('One'), f('=5*2', 10), v('')],
    ]
    const newGrid: CellValue[][] = [
      ['sku', 'slug', 'name', 'price', 'colour'],
      ['S1', 'p1', 'One', 10, 'red'],
    ]
    const preserved = planFormulaPreservation({ oldGrid, newGrid, keyStrategies: KEYS })
    expect(preserved.map((p) => p.formula)).toEqual(['=5*2'])
  })
})
