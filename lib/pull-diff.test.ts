import { describe, it, expect, vi } from 'vitest'
import type { PatVariationColumn } from '@/modules/product-attributes-for-shop/lib/types'

// Repro: does diffVariationRows detect an ATTRIBUTE-ONLY edit (e.g. the "Catalog"
// column contributed by product-attributes-for-shop), where nothing else on the
// row changed? If it reads 'unchanged', filterGridByDiff drops the row and the
// edit is silently lost.

// --- attributes provider DB seam (mirrors the provider's own test) ---
const listVariationColumns = vi.fn(async (_id: string): Promise<PatVariationColumn[]> => [
  { assignmentId: 'asg-catalog', attributeId: 'attr-catalog', name: 'Catalog', position: 0, values: [] },
])
// Child 'child-1' currently holds catalog value "Spring" (id v-spring).
const getVariantAttributeValues = vi.fn(
  async (_p: string, _c: string[]): Promise<Record<string, Record<string, { valueId: string; label: string }>>> => ({
    'child-1': { 'asg-catalog': { valueId: 'v-spring', label: 'Spring' } },
  }),
)
const setVariantAttributeValue = vi.fn(async () => {})
const ensureAttributeValueByLabel = vi.fn(async (_a: string, label: string): Promise<string | null> => `v-${label.toLowerCase()}`)
// Read-only: a label the vocabulary has NOT seen yet has no id (null), exactly
// like the real query. Known seed labels resolve to their id.
const KNOWN = new Set(['spring', 'summer'])
const findAttributeValueByLabel = vi.fn(async (_a: string, label: string): Promise<string | null> =>
  KNOWN.has(label.toLowerCase()) ? `v-${label.toLowerCase()}` : null,
)

vi.mock('@/modules/product-attributes-for-shop/components/admin/ProductAttributesVariantCell', () => ({
  ProductAttributesVariantCell: () => null,
}))
vi.mock('@/modules/product-attributes-for-shop/lib/db/membership', () => ({
  listVariationColumns: (...a: unknown[]) => listVariationColumns(...(a as [string])),
  getVariantAttributeValues: (...a: unknown[]) => getVariantAttributeValues(...(a as [string, string[]])),
  setVariantAttributeValue: (...a: unknown[]) => setVariantAttributeValue(),
  ensureAttributeValueByLabel: (...a: unknown[]) => ensureAttributeValueByLabel(...(a as [string, string])),
  findAttributeValueByLabel: (...a: unknown[]) => findAttributeValueByLabel(...(a as [string, string])),
  // The Catalog attribute in these tests is already assigned to the product, so
  // auto-assign never fires; an empty vocabulary keeps it that way.
  listAllAttributes: async () => [],
  upsertProductAttribute: async () => null,
}))

// --- shop / variations DB seams diffVariationRows imports ---
const buildProductCsvRows = vi.fn(async (): Promise<Record<string, string>[]> => [])
vi.mock('@/modules/shop/lib/csv-rows', () => ({ buildProductCsvRows: (...a: unknown[]) => buildProductCsvRows(...(a as [])) }))
vi.mock('@/modules/shop/lib/db/products', () => ({
  getProductsBySlugs: vi.fn(async (_slugs: string[]) => new Map([['widget', { id: 'p1', name: 'Widget', slug: 'widget' }]])),
}))
// A fake product-field provider whose rowChanged the test drives, so diffProductRows'
// provider-awareness is exercised without the real attribute DB.
const productRowChanged = vi.fn(async (): Promise<boolean> => false)
vi.mock('@/modules/shop/lib/product-field-providers', () => ({
  resolveProductFieldProviders: vi.fn(async () => [{
    id: 'product-attributes',
    provider: {
      listColumns: async () => [],
      getValues: async () => ({}),
      beginImport: async () => ({}),
      applyImportedRow: async () => false,
      rowChanged: (...a: unknown[]) => productRowChanged(...(a as [])),
    },
  }]),
}))
vi.mock('@/modules/shop-variations/lib/variants-service', () => ({
  getEditorPayloadsBatch: vi.fn(async () => new Map([['p1', {
    product: { id: 'p1', name: 'Widget', slug: 'widget', price: 10 },
    options: [{ name: 'Size', values: [{ id: 'val-large', label: 'Large' }] }],
    variants: [{
      variantId: 'var-1', childProductId: 'child-1', optionValueIds: ['val-large'], label: 'Large',
      enabled: true, price: 10, salePrice: null, retailPrice: null, tradePrice: null, costPrice: null,
      sku: null, barcode: null, supplier: null, trackInventory: false, stockCount: null, weight: null, imageUrls: [],
    }],
    addons: [],
  }]])),
}))
vi.mock('@/modules/shop-variations/lib/csv', () => ({ parseVariantImages: (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean) }))

// resolveVariantFieldProviders returns the REAL attributes provider, so the diff
// runs the real rowChanged path.
import { productAttributesVariantFieldProvider } from '@/modules/product-attributes-for-shop/lib/variant-field-provider'
vi.mock('@/modules/shop-variations/lib/variant-field-providers', () => ({
  resolveVariantFieldProviders: vi.fn(async () => [
    { id: 'product-attributes-for-shop', provider: productAttributesVariantFieldProvider },
  ]),
}))

import { diffVariationRows, diffProductRows } from '@/modules/google-sheet-products-for-shop/lib/pull-diff'
import { CSV_COLUMNS } from '@/modules/shop/lib/csv'

describe('diffVariationRows - attribute-only edit', () => {
  it('flags a Catalog attribute change as update, not unchanged', async () => {
    const grid = [
      ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Catalog'],
      // Same variant (child-1, Size=Large), only the Catalog cell changed Spring -> Summer.
      ['widget', 'Size', 'Large', 'child-1', 'Summer'],
    ]
    const results = await diffVariationRows(grid)
    expect(results).toHaveLength(1)
    expect(results[0]?.kind).toBe('update')
  })

  it('leaves an unchanged Catalog cell as unchanged', async () => {
    const grid = [
      ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Catalog'],
      ['widget', 'Size', 'Large', 'child-1', 'Spring'],
    ]
    const results = await diffVariationRows(grid)
    expect(results[0]?.kind).toBe('unchanged')
  })

  // Regression: the Pull used to drop the first values typed into a brand-new
  // attribute's column. The variant had no value yet (stored null) and the label
  // was one the vocabulary had never seen (resolves null too), so the diff read
  // null === null as "unchanged" and filterGridByDiff dropped the row before the
  // importer - which would have created and assigned the value - ever saw it.
  it('flags the first value typed into a brand-new attribute column as update', async () => {
    getVariantAttributeValues.mockResolvedValueOnce({}) // child-1 has no catalog value
    const grid = [
      ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Catalog'],
      ['widget', 'Size', 'Large', 'child-1', 'Autumn 2026 Brochure'],
    ]
    const results = await diffVariationRows(grid)
    expect(results[0]?.kind).toBe('update')
  })
})

// The Products-tab twin: a row whose fixed columns all match the shop but whose
// product-level attribute column (Markup) was edited must read as an update, or
// filterGridByDiff drops it and the attribute edit is lost - the same silent-loss
// bug the variation side has.
describe('diffProductRows - product-level attribute edit', () => {
  // An existing "Widget" whose fixed columns match the sheet exactly, so the only
  // possible change is a provider (attribute) column.
  const existing = { ...Object.fromEntries(CSV_COLUMNS.map((c) => [c, ''])), name: 'Widget', slug: 'widget', type: 'PHYSICAL', price: '10' } as Record<string, string>
  const header = [...CSV_COLUMNS, 'Markup']
  const rowCells = (markup: string) => [...CSV_COLUMNS.map((c) => existing[c] ?? ''), markup]

  it('flags a Markup attribute change as update, not unchanged', async () => {
    buildProductCsvRows.mockResolvedValueOnce([existing])
    productRowChanged.mockResolvedValueOnce(true)
    const results = await diffProductRows([header, rowCells('Premium')])
    expect(results).toHaveLength(1)
    expect(results[0]?.kind).toBe('update')
  })

  it('leaves an unchanged product alone', async () => {
    buildProductCsvRows.mockResolvedValueOnce([existing])
    productRowChanged.mockResolvedValueOnce(false)
    const results = await diffProductRows([header, rowCells('')])
    expect(results[0]?.kind).toBe('unchanged')
  })
})

// Regression: Push preserves an owner's price formula when its result matches
// the shop within float tolerance (formula-preserve's numbersMatch), so the
// sheet legitimately holds 122.10000000000002 where the shop holds 122.1. The
// diff used exact numeric equality, so every preserved-formula row read as an
// update on every Pull, forever - on the live deskwell sheet that was 284 of
// 575 variation rows flagged straight after a Push that changed nothing.
describe('float noise from preserved formulas reads as unchanged', () => {
  it('variation Price with formula float noise is unchanged', async () => {
    const grid = [
      ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Price', 'Catalog'],
      // v.price is 10; a preserved "=x*y" formula reads back with float noise.
      ['widget', 'Size', 'Large', 'child-1', '10.000000000000002', 'Spring'],
    ]
    const results = await diffVariationRows(grid)
    expect(results[0]?.kind).toBe('unchanged')
  })

  it('a real variation price change still flags as update', async () => {
    const grid = [
      ['Parent Slug', 'Option 1', 'Value 1', 'Variant ID', 'Price', 'Catalog'],
      ['widget', 'Size', 'Large', 'child-1', '10.5', 'Spring'],
    ]
    const results = await diffVariationRows(grid)
    expect(results[0]?.kind).toBe('update')
  })

  it('product price with formula float noise is unchanged', async () => {
    const noisy = { ...Object.fromEntries(CSV_COLUMNS.map((c) => [c, ''])), name: 'Widget', slug: 'widget', type: 'PHYSICAL', price: '122.1' } as Record<string, string>
    buildProductCsvRows.mockResolvedValueOnce([noisy])
    productRowChanged.mockResolvedValueOnce(false)
    const cells = CSV_COLUMNS.map((c) => (c === 'price' ? '122.10000000000002' : noisy[c] ?? ''))
    const results = await diffProductRows([[...CSV_COLUMNS], cells])
    expect(results[0]?.kind).toBe('unchanged')
  })
})
