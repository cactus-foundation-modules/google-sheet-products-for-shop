import { describe, it, expect } from 'vitest'
import {
  productTabTitle,
  isVariationTab,
  splitWideGridByProduct,
  mergeVariationTabs,
  slugsInMergedGrid,
  missingManifestSlugs,
  RESERVED_TAB_TITLES,
} from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'

// The wide header exactly as shop-variations' exportVariationsCsv writes it, for a
// catalogue whose widest product has two options and where one product carries an
// extra module field ("Material"). Product B uses only one option and no field.
const WIDE_HEADER = [
  'Parent Slug', 'Parent Name',
  'Option 1', 'Value 1', 'Option 2', 'Value 2',
  'Variant SKU', 'Price', 'Sale Price', 'RRP', 'Trade Price', 'Cost Price',
  'Stock', 'Barcode', 'Supplier', 'Weight', 'Image', 'Variant ID',
  'Material',
]

// desk: two options (Finish, Size), one with a Material value.
// stool: one option (Colour), Option 2 / Value 2 blank, no Material.
const WIDE: string[][] = [
  WIDE_HEADER,
  ['desk', 'Oak Desk', 'Finish', 'Oak', 'Size', '1400', 'D-OAK-14', '299', '', '', '', '150', '5', '', 'Acme', '30', 'a.jpg', 'child-1', 'Solid oak'],
  ['desk', 'Oak Desk', 'Finish', 'Walnut', 'Size', '1600', 'D-WAL-16', '349', '', '', '', '175', '3', '', 'Acme', '32', 'b.jpg', 'child-2', 'Solid walnut'],
  ['stool', 'Bar Stool', 'Colour', 'Red', '', '', 'S-RED', '49', '', '', '', '', '20', '', 'Acme', '5', 'c.jpg', 'child-3', ''],
]

describe('productTabTitle', () => {
  it('uses the product name, cleaning forbidden characters', () => {
    const title = productTabTitle('Oak / Walnut [Desk]', 'oak-desk', new Set())
    expect(title).not.toMatch(/[[\]:*?/\\]/)
    expect(title).toBe('Oak Walnut Desk')
  })

  it('disambiguates a duplicate name with the slug', () => {
    const taken = new Set<string>()
    const a = productTabTitle('Desk', 'desk-a', taken)
    const b = productTabTitle('Desk', 'desk-b', taken)
    expect(a).toBe('Desk')
    expect(b).not.toBe('Desk')
    expect(b).toContain('desk-b')
  })

  it('never returns a reserved title', () => {
    const title = productTabTitle('Products', 'products', new Set())
    expect(RESERVED_TAB_TITLES.has(title)).toBe(false)
  })

  it('truncates to Google\'s 100-character limit', () => {
    const title = productTabTitle('x'.repeat(200), 'y'.repeat(200), new Set())
    expect(title.length).toBeLessThanOrEqual(100)
  })
})

describe('isVariationTab', () => {
  it('accepts a non-reserved tab whose first header cell is Parent Slug', () => {
    expect(isVariationTab('Oak Desk', ['Parent Slug', 'Parent Name'])).toBe(true)
  })
  it('rejects reserved tabs even with the marker', () => {
    expect(isVariationTab('Products', ['Parent Slug'])).toBe(false)
    expect(isVariationTab('Read me', ['Parent Slug'])).toBe(false)
  })
  it('rejects a tab without the marker', () => {
    expect(isVariationTab('Owner notes', ['My column'])).toBe(false)
  })
})

describe('splitWideGridByProduct', () => {
  const tabs = splitWideGridByProduct(WIDE)

  it('produces one tab per product, in first-appearance order', () => {
    expect(tabs.map((t) => t.slug)).toEqual(['desk', 'stool'])
    expect(tabs.map((t) => t.name)).toEqual(['Oak Desk', 'Bar Stool'])
  })

  it('keeps only the option pairs each product uses', () => {
    const desk = tabs[0]!.grid[0]!
    const stool = tabs[1]!.grid[0]!
    expect(desk).toContain('Option 2')
    expect(desk).toContain('Value 2')
    // stool has one option, so no second pair
    expect(stool).not.toContain('Option 2')
    expect(stool).not.toContain('Value 2')
  })

  it('keeps an extra field column only for products that use it', () => {
    expect(tabs[0]!.grid[0]!).toContain('Material')
    expect(tabs[1]!.grid[0]!).not.toContain('Material')
  })

  it('keeps all fixed columns on every tab', () => {
    for (const t of tabs) {
      for (const col of ['Variant SKU', 'Price', 'Cost Price', 'Stock', 'Variant ID']) {
        expect(t.grid[0]!).toContain(col)
      }
    }
  })

  it('carries the variant values across intact', () => {
    // desk row 1: Finish=Oak, Size=1400, price 299, Material "Solid oak"
    const desk = tabs[0]!.grid
    const h = desk[0]!
    const row = desk[1]!
    expect(row[h.indexOf('Value 1')]).toBe('Oak')
    expect(row[h.indexOf('Value 2')]).toBe('1400')
    expect(row[h.indexOf('Price')]).toBe('299')
    expect(row[h.indexOf('Material')]).toBe('Solid oak')
    expect(row[h.indexOf('Variant ID')]).toBe('child-1')
  })
})

describe('mergeVariationTabs', () => {
  it('widens back to the superset header and blanks absent cells', () => {
    const tabs = splitWideGridByProduct(WIDE).map((t) => t.grid as string[][])
    const merged = mergeVariationTabs(tabs)
    const h = merged[0]!
    // superset has both option pairs and the field
    expect(h).toContain('Option 2')
    expect(h).toContain('Material')
    // stool row: Option 2 / Value 2 / Material all blank
    const stoolRow = merged.find((r) => r[h.indexOf('Parent Slug')] === 'stool')!
    expect(stoolRow[h.indexOf('Value 2')]).toBe('')
    expect(stoolRow[h.indexOf('Material')]).toBe('')
    expect(stoolRow[h.indexOf('Value 1')]).toBe('Red')
  })

  it('round-trips: split then merge reproduces the wide grid by column name', () => {
    const tabs = splitWideGridByProduct(WIDE).map((t) => t.grid as string[][])
    const merged = mergeVariationTabs(tabs)
    const mh = merged[0]!
    const wh = WIDE[0]!
    // Every original column is present in the merged header.
    for (const col of wh) expect(mh).toContain(col)
    // Every data row matches cell-for-cell, looked up by column name.
    for (let r = 1; r < WIDE.length; r++) {
      const orig = WIDE[r]!
      const slug = orig[wh.indexOf('Parent Slug')]
      const variantId = orig[wh.indexOf('Variant ID')]
      const mrow = merged.find((row) => row[mh.indexOf('Variant ID')] === variantId)!
      expect(mrow, `row for ${slug}/${variantId}`).toBeTruthy()
      for (const col of wh) {
        expect(mrow[mh.indexOf(col)], `${slug} ${col}`).toBe(orig[wh.indexOf(col)])
      }
    }
  })

  it('drops wholly blank padding rows', () => {
    const tab = [
      ['Parent Slug', 'Parent Name', 'Option 1', 'Value 1', 'Variant SKU', 'Price', 'Sale Price', 'RRP', 'Trade Price', 'Cost Price', 'Stock', 'Barcode', 'Supplier', 'Weight', 'Image', 'Variant ID'],
      ['stool', 'Bar Stool', 'Colour', 'Red', 'S-RED', '49', '', '', '', '', '20', '', '', '', '', 'child-3'],
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]
    const merged = mergeVariationTabs([tab])
    // header + one real row only
    expect(merged.length).toBe(2)
  })
})

describe('manifest guard', () => {
  it('reports slugs present at last push but missing from the sheet now', () => {
    const merged = mergeVariationTabs(splitWideGridByProduct(WIDE).map((t) => t.grid as string[][]))
    const present = slugsInMergedGrid(merged)
    expect(present).toEqual(new Set(['desk', 'stool']))
    expect(missingManifestSlugs(['desk', 'stool'], present)).toEqual([])
    expect(missingManifestSlugs(['desk', 'stool', 'chair'], present)).toEqual(['chair'])
  })

  it('an empty manifest disables the check', () => {
    expect(missingManifestSlugs([], new Set())).toEqual([])
  })
})
