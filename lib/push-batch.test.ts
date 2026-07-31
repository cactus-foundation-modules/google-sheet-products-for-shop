import { describe, it, expect } from 'vitest'
import { planTabPush } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { gridHash } from '@/modules/google-sheet-products-for-shop/lib/grid-hash'
import { perMinuteFromEnv } from '@/modules/google-sheet-products-for-shop/lib/rate-limit'
import type { SheetCell, CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// `v` is a plain value cell, `f` a formula cell with its current result.
const v = (value: CellValue): SheetCell => ({ formula: null, value: String(value), error: false })
const f = (formula: string, value: CellValue): SheetCell => ({ formula, value: String(value), error: false })

const KEYS = [['sku'], ['slug']]
const HEADER = ['sku', 'slug', 'name', 'price']
const OWNS = (h: string) => HEADER.includes(h)
const header: CellValue[] = [...HEADER]

const input = (grid: CellValue[][]) => ({ tab: 'T', grid, keyStrategies: KEYS, ownsColumn: OWNS })

describe('planTabPush skip detection', () => {
  const sheet: SheetCell[][] = [
    [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
    [v('S1'), v('p1'), v('One'), v('10'), v('keep-1')],
    [v('S2'), v('p2'), v('Two'), v('20'), v('keep-2')],
  ]

  it('skips a tab whose pushed cells already match, owner column and all', () => {
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S2', 'p2', 'Two', 20]]
    const plan = planTabPush(input(grid), sheet)
    expect(plan.skip).toBe(true)
    expect(plan.clears).toEqual([])
    expect(plan.doomedRows).toEqual([])
  })

  it('does not skip when a value changed', () => {
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 12], ['S2', 'p2', 'Two', 20]]
    expect(planTabPush(input(grid), sheet).skip).toBe(false)
  })

  it('does not skip when a product row is new', () => {
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10], ['S2', 'p2', 'Two', 20], ['S3', 'p3', 'Three', 30]]
    expect(planTabPush(input(grid), sheet).skip).toBe(false)
  })

  it('does not skip when a product left (row delete pending)', () => {
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10]]
    const plan = planTabPush(input(grid), sheet)
    expect(plan.skip).toBe(false)
    expect(plan.doomedRows).toEqual([2])
  })

  it('skips with a matching formula in place - the formula survives untouched', () => {
    const withFormula: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price')],
      [v('S1'), v('p1'), v('One'), f('=5*2', 10)],
    ]
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10]]
    const plan = planTabPush(input(grid), withFormula)
    expect(plan.skip).toBe(true)
    expect(plan.preserved).toEqual([{ row: 1, col: 3, formula: '=5*2' }])
  })

  it('does not skip over an erroring formula cell', () => {
    const withError: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price')],
      [v('S1'), v('p1'), v('One'), { formula: '=1/0', value: '', error: true }],
    ]
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', '']]
    expect(planTabPush(input(grid), withError).skip).toBe(false)
  })

  it('an empty tab (just created) is never skipped', () => {
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10]]
    expect(planTabPush(input(grid), []).skip).toBe(false)
  })

  it('numbers match with float tolerance, same as formula preservation', () => {
    const sheetFloat: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price')],
      [v('S1'), v('p1'), v('One'), v('15.000000000000002')],
    ]
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 15]]
    expect(planTabPush(input(grid), sheetFloat).skip).toBe(true)
  })
})

describe('planTabPush clear planning', () => {
  it('plans no clear for stale rows that are already blank in the pushed columns', () => {
    const sheet: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      [v('S1'), v('p1'), v('One'), v('10'), v('')],
      // Below the catalogue: pushed cells blank, owner note present - the row
      // survives (identity delete never touches it) and needs no clearing write.
      [v(''), v(''), v(''), v(''), v('mine')],
    ]
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10]]
    const plan = planTabPush(input(grid), sheet)
    expect(plan.clears).toEqual([])
    expect(plan.skip).toBe(true)
  })

  it('still plans the clear when a stale row holds pushed content', () => {
    const sheet: SheetCell[][] = [
      [v('sku'), v('slug'), v('name'), v('price'), v('notes')],
      [v('S1'), v('p1'), v('One'), v('10'), v('')],
      [v(''), v(''), v('Ghost'), v(''), v('mine')], // survives the delete, needs a clear
    ]
    const grid: CellValue[][] = [header, ['S1', 'p1', 'One', 10]]
    const plan = planTabPush(input(grid), sheet)
    expect(plan.clears).toEqual(['A3:D3'])
    expect(plan.skip).toBe(false)
  })

  it('plans a widening insert exactly as the single-tab push did', () => {
    const sheet: SheetCell[][] = [
      [v('sku'), v('slug'), v('notes')],
      [v('S1'), v('p1'), v('mine')],
    ]
    const grid: CellValue[][] = [['sku', 'slug', 'name'], ['S1', 'p1', 'One']]
    const plan = planTabPush({ tab: 'T', grid, keyStrategies: KEYS, ownsColumn: (h) => ['sku', 'slug', 'name'].includes(h) }, sheet)
    expect(plan.insert).toEqual({ at: 2, count: 1 })
    expect(plan.skip).toBe(false)
  })
})

describe('gridHash', () => {
  it('is stable for equal grids and different for different ones', () => {
    const a: CellValue[][] = [['sku', 'price'], ['S1', 10]]
    const b: CellValue[][] = [['sku', 'price'], ['S1', 10]]
    const c: CellValue[][] = [['sku', 'price'], ['S1', 11]]
    expect(gridHash(a)).toBe(gridHash(b))
    expect(gridHash(a)).not.toBe(gridHash(c))
  })

  it('tells the number 10 from the string "10" - the cell type matters to Sheets', () => {
    expect(gridHash([[10]])).not.toBe(gridHash([['10']]))
  })
})

describe('perMinuteFromEnv', () => {
  it('takes a sane value and floors it', () => {
    expect(perMinuteFromEnv('300')).toBe(300)
    expect(perMinuteFromEnv('90.9')).toBe(90)
  })
  it('falls back to 60 on unset, blank, zero, negative or nonsense', () => {
    expect(perMinuteFromEnv(undefined)).toBe(60)
    expect(perMinuteFromEnv('')).toBe(60)
    expect(perMinuteFromEnv(' ')).toBe(60)
    expect(perMinuteFromEnv('0')).toBe(60)
    expect(perMinuteFromEnv('-5')).toBe(60)
    expect(perMinuteFromEnv('lots')).toBe(60)
  })
})
