import { listProducts, getProductMedia, getProductCategoryIds, getProductTagIds, getProductCollectionIds } from '@/modules/shop/lib/db'
import { listCategories, listTags, listCollections } from '@/modules/shop/lib/db/catalogue'
import { getTaxClassCodesByIds } from '@/modules/shop/lib/db/tax-shipping'
import { CSV_COLUMNS, collectPaged, serializeMedia, type CsvColumn } from '@/modules/shop/lib/csv'
import type { ShpProduct } from '@/modules/shop/lib/types'
import { clearTab, writeGrid } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB, applyProductsValidation } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// The Products header, minus cost_price when the owner has hidden their margins.
// Dropping the column (rather than blanking it) is deliberate: a blank column on
// Pull would null every product's cost price; an absent column leaves it alone.
export function productColumns(includeCostPrice: boolean): CsvColumn[] {
  return CSV_COLUMNS.filter((c) => includeCostPrice || c !== 'cost_price')
}

// Build the Products grid: header row + one row per (non-hidden) product, in the
// same shape shop's CSV export produces. We assemble the grid directly rather
// than round-tripping through CSV text - the write is RAW, so shop's
// formula-injection guard (which prefixes a leading apostrophe) is both
// redundant and would show the owner a stray ' in their cells.
export async function buildProductsGrid(includeCostPrice: boolean): Promise<string[][]> {
  const products = await collectPaged<ShpProduct>(async (page) => {
    const { products: items, total } = await listProducts({ page, perPage: 100, excludeHidden: true })
    return { items, total }
  })

  const [categories, tags, collections] = await Promise.all([listCategories(), listTags(), listCollections()])
  const categoryById = new Map(categories.map((c) => [c.id, c.slug]))
  const tagById = new Map(tags.map((t) => [t.id, t.slug]))
  const collectionById = new Map(collections.map((c) => [c.id, c.slug]))
  const taxCodeById = await getTaxClassCodesByIds(products.map((p) => p.taxClassId).filter((id): id is string => !!id))

  const columns = productColumns(includeCostPrice)
  const grid: string[][] = [columns.map((c) => c)]

  for (const p of products) {
    const [media, categoryIds, tagIds, collectionIds] = await Promise.all([
      getProductMedia(p.id), getProductCategoryIds(p.id), getProductTagIds(p.id), getProductCollectionIds(p.id),
    ])
    const { imageUrls, imageAlt } = serializeMedia(media)
    const rec: Record<CsvColumn, string> = {
      sku: p.sku ?? '', name: p.name, type: p.type, status: p.status, description: p.description ?? '',
      short_description: p.shortDescription ?? '', price: p.price, compare_at_price: p.compareAtPrice ?? '',
      cost_price: p.costPrice ?? '', tax_class: (p.taxClassId && taxCodeById.get(p.taxClassId)) || '',
      track_inventory: String(p.trackInventory), stock_count: p.stockCount != null ? String(p.stockCount) : '',
      low_stock_threshold: p.lowStockThreshold != null ? String(p.lowStockThreshold) : '', out_of_stock_behaviour: p.outOfStockBehaviour,
      weight: p.weight ?? '', weight_unit: p.weightUnit ?? '',
      categories: categoryIds.map((id) => categoryById.get(id)).filter(Boolean).join('|'),
      tags: tagIds.map((id) => tagById.get(id)).filter(Boolean).join('|'),
      collections: collectionIds.map((id) => collectionById.get(id)).filter(Boolean).join('|'),
      meta_title: p.metaTitle ?? '', meta_description: p.metaDescription ?? '',
      image_urls: imageUrls, image_alt: imageAlt, barcode: p.barcode ?? '',
    }
    grid.push(columns.map((c) => rec[c] ?? ''))
  }
  return grid
}

// DB -> Products tab. Returns the number of product rows written (excl. header).
export async function pushProductsTab(spreadsheetId: string, includeCostPrice: boolean): Promise<{ rowCount: number }> {
  const grid = await buildProductsGrid(includeCostPrice)
  await clearTab(spreadsheetId, TAB.PRODUCTS)
  await writeGrid(spreadsheetId, TAB.PRODUCTS, grid)
  // Dropdowns for type/status/out_of_stock_behaviour, positioned for this exact
  // column layout (cost_price may or may not be present).
  await applyProductsValidation(spreadsheetId, productColumns(includeCostPrice))
  return { rowCount: Math.max(grid.length - 1, 0) }
}
