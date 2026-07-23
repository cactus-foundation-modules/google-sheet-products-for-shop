import { describe, it, expect } from 'vitest'
import { planFormulaPreservation, toFormulaRuns, valuesMatch } from '@/modules/google-sheet-products-for-shop/lib/formula-preserve'
import type { SheetCell, CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// Shorthand builders. `v` is a plain value cell, `f` a formula cell with the
// result it currently evaluates to, `e` a formula that is currently erroring.
const v = (value: CellValue): SheetCell => ({ formula: null, value: String(value), error: false })
const f = (formula: string, value: CellValue): SheetCell => ({ formula, value: String(value), error: false })
const e = (formula: string): SheetCell => ({ formula, value: '', error: true })

const KEYS = [['sku'], ['slug']]
const HEADER = ['sku', 'slug', 'name', 'price']
const oldHeader = HEADER.map(v)

function plan(oldGrid: SheetCell[][], newGrid: CellValue[][]) {
  return planFormulaPreservation({ oldGrid, newGrid, keyStrategies: KEYS })
}

describe('valuesMatch', () => {
  it('accepts a numeric result within floating-point noise', () => {
    // "=12.5*1.2" really does evaluate to 15.000000000000002.
    expect(valuesMatch('15.000000000000002', 15)).toBe(true)
    expect(valuesMatch('15', 15)).toBe(true)
  })

  it('rejects a numeric result that genuinely differs', () => {
    expect(valuesMatch('15.01', 15)).toBe(false)
    expect(valuesMatch('', 15)).toBe(false)
    expect(valuesMatch('not a number', 15)).toBe(false)
  })

  it('holds the same relative tolerance at a large magnitude', () => {
    expect(valuesMatch('30000.000000001', 30000)).toBe(true)
    expect(valuesMatch('30000.01', 30000)).toBe(false)
  })

  it('compares booleans by their sheet spelling', () => {
    expect(valuesMatch('true', true)).toBe(true)
    expect(valuesMatch('TRUE', true)).toBe(true)
    expect(valuesMatch('false', true)).toBe(false)
  })

  it('compares text exactly, with no numeric leniency', () => {
    expect(valuesMatch(' Blue Chair ', 'Blue Chair')).toBe(true)
    expect(valuesMatch('Blue chair', 'Blue Chair')).toBe(false)
    // Leading zeros are meaningful in a barcode, so "0100" is not 100 - which is
    // why text is never compared as a number.
    expect(valuesMatch('100', '0100')).toBe(false)
    expect(valuesMatch('100', '100.0')).toBe(false)
  })
})

describe('planFormulaPreservation', () => {
  it('keeps a formula whose result matches the database', () => {
    const oldGrid = [oldHeader, [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [HEADER, ['A1', 'chair', 'Chair', 15]]
    expect(plan(oldGrid, newGrid)).toEqual([{ row: 1, col: 3, formula: '=D2*1.2' }])
  })

  it('drops a formula whose result no longer matches the database', () => {
    const oldGrid = [oldHeader, [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [HEADER, ['A1', 'chair', 'Chair', 18]]
    expect(plan(oldGrid, newGrid)).toEqual([])
  })

  it('drops a formula that is currently erroring', () => {
    const oldGrid = [oldHeader, [v('A1'), v('chair'), v('Chair'), e('=1/0')]]
    const newGrid: CellValue[][] = [HEADER, ['A1', 'chair', 'Chair', '']]
    expect(plan(oldGrid, newGrid)).toEqual([])
  })

  it('drops every formula when a row has moved (option a)', () => {
    // A new product inserted at the top pushes A1 from row 1 to row 2. Its
    // formula still says D2, so it must not travel with it.
    const oldGrid = [oldHeader, [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [
      HEADER,
      ['A0', 'stool', 'Stool', 9],
      ['A1', 'chair', 'Chair', 15],
    ]
    expect(plan(oldGrid, newGrid)).toEqual([])
  })

  it('drops every formula when the header changes shape', () => {
    // cost_price switched on shifts every column to its right.
    const shifted = ['sku', 'slug', 'cost_price', 'name', 'price']
    const oldGrid = [oldHeader, [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [shifted, ['A1', 'chair', 4, 'Chair', 15]]
    expect(planFormulaPreservation({ oldGrid, newGrid, keyStrategies: KEYS })).toEqual([])
  })

  it('tolerates the owner having extra columns to the right', () => {
    const wideHeader = [...oldHeader, v('my margin')]
    const oldGrid = [wideHeader, [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15), f('=E2-4', 11)]]
    const newGrid: CellValue[][] = [HEADER, ['A1', 'chair', 'Chair', 15]]
    // Only the pushed cell is planned; the owner's own column is never written
    // to, so it needs no preserving.
    expect(plan(oldGrid, newGrid)).toEqual([{ row: 1, col: 3, formula: '=D2*1.2' }])
  })

  it('falls back to slug when a product has no SKU', () => {
    const oldGrid = [oldHeader, [v(''), v('chair'), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [HEADER, ['', 'chair', 'Chair', 15]]
    expect(plan(oldGrid, newGrid)).toEqual([{ row: 1, col: 3, formula: '=D2*1.2' }])
  })

  it('keeps nothing for a row it cannot identify', () => {
    const oldGrid = [oldHeader, [v(''), v(''), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [HEADER, ['', '', 'Chair', 15]]
    expect(plan(oldGrid, newGrid)).toEqual([])
  })

  it('does not match a row whose identity changed under it', () => {
    // Same position, different product - a slug edit in the admin.
    const oldGrid = [oldHeader, [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15)]]
    const newGrid: CellValue[][] = [HEADER, ['A2', 'stool', 'Chair', 15]]
    expect(plan(oldGrid, newGrid)).toEqual([])
  })

  it('never touches the header row', () => {
    const formulaHeader = [v('sku'), v('slug'), v('name'), f('="price"', 'price')]
    const oldGrid = [formulaHeader, [v('A1'), v('chair'), v('Chair'), v(15)]]
    const newGrid: CellValue[][] = [HEADER, ['A1', 'chair', 'Chair', 15]]
    expect(plan(oldGrid, newGrid)).toEqual([])
  })

  it('returns nothing for an empty or header-only sheet', () => {
    expect(plan([], [HEADER, ['A1', 'chair', 'Chair', 15]])).toEqual([])
    expect(plan([oldHeader], [HEADER, ['A1', 'chair', 'Chair', 15]])).toEqual([])
  })

  it('ignores old rows beyond the new grid', () => {
    const oldGrid = [
      oldHeader,
      [v('A1'), v('chair'), v('Chair'), f('=D2*1.2', 15)],
      [v('A2'), v('stool'), v('Stool'), f('=D3*1.2', 9)],
    ]
    const newGrid: CellValue[][] = [HEADER, ['A1', 'chair', 'Chair', 15]]
    expect(plan(oldGrid, newGrid)).toEqual([{ row: 1, col: 3, formula: '=D2*1.2' }])
  })
})

describe('toFormulaRuns', () => {
  it('merges cells that sit side by side in one row', () => {
    expect(
      toFormulaRuns([
        { row: 1, col: 3, formula: '=A' },
        { row: 1, col: 4, formula: '=B' },
        { row: 1, col: 6, formula: '=C' },
        { row: 2, col: 3, formula: '=D' },
      ])
    ).toEqual([
      { row: 1, col: 3, formulas: ['=A', '=B'] },
      { row: 1, col: 6, formulas: ['=C'] },
      { row: 2, col: 3, formulas: ['=D'] },
    ])
  })

  it('returns nothing for an empty plan', () => {
    expect(toFormulaRuns([])).toEqual([])
  })
})
