import { describe, it, expect } from 'vitest'
import {
  DEFAULT_COLUMN_PREFS,
  columnPrefsFrom,
  excludedProductColumns,
  excludedVariationColumns,
} from '@/modules/google-sheet-products-for-shop/lib/columns'
import { missingProductsColumns } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { CSV_COLUMNS } from '@/modules/shop/lib/csv'

describe('column preferences', () => {
  it('includes everything by default', () => {
    expect(excludedProductColumns(DEFAULT_COLUMN_PREFS)).toEqual([])
    expect(excludedVariationColumns(DEFAULT_COLUMN_PREFS)).toEqual([])
  })

  it('falls back to everything included when there is no connection row', () => {
    expect(columnPrefsFrom(null)).toEqual(DEFAULT_COLUMN_PREFS)
  })

  it('names the stock and trade-price columns on both tabs when switched off', () => {
    const prefs = { includeStock: false, includeTradePrice: false }
    expect(excludedProductColumns(prefs)).toEqual(['stock_count', 'trade_price'])
    expect(excludedVariationColumns(prefs)).toEqual(['Stock', 'Trade Price'])
  })

  it('leaves the inventory settings alone when the stock count goes', () => {
    // The count is a figure; track_inventory, the threshold and the out-of-stock
    // behaviour are settings, and switching the figure off must not take them.
    const excluded = excludedProductColumns({ includeStock: false, includeTradePrice: true })
    expect(excluded).not.toContain('track_inventory')
    expect(excluded).not.toContain('low_stock_threshold')
    expect(excluded).not.toContain('out_of_stock_behaviour')
  })
})

describe('missingProductsColumns', () => {
  const fullHeader = [...CSV_COLUMNS]
  const without = (col: string) => [fullHeader.filter((c) => c !== col)]

  it('reports a genuinely missing required column', () => {
    expect(missingProductsColumns(without('price'))).toContain('price')
  })

  it('reports a switched-off column when it is still switched ON', () => {
    expect(missingProductsColumns(without('stock_count'))).toContain('stock_count')
  })

  it('does not report a column the owner has switched off', () => {
    const excluded = excludedProductColumns({ includeStock: false, includeTradePrice: true })
    expect(missingProductsColumns(without('stock_count'), excluded)).toEqual([])
  })

  it('still reports other missing columns when one is switched off', () => {
    const grid = [fullHeader.filter((c) => c !== 'stock_count' && c !== 'price')]
    const excluded = excludedProductColumns({ includeStock: false, includeTradePrice: true })
    expect(missingProductsColumns(grid, excluded)).toEqual(['price'])
  })
})
