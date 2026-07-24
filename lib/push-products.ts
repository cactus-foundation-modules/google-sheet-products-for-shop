import { CSV_COLUMNS, NUMERIC_CSV_COLUMNS, BOOLEAN_CSV_COLUMNS, type CsvColumn } from '@/modules/shop/lib/csv'
import { buildProductCsvRows } from '@/modules/shop/lib/csv-rows'
import { getProductsBySlugs } from '@/modules/shop/lib/db/products'
import { resolveProductFieldProviders } from '@/modules/shop/lib/product-field-providers'
import { type CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { coerceOpenCell } from '@/modules/google-sheet-products-for-shop/lib/numeric-cell'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { TAB, applyProductsValidation } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// The full Products header. Cost price is always included - the owner asked for
// it to go every time rather than sit behind an on/off setting. It is a reference
// figure like RRP and trade, and anyone the sheet is shared with can see it.
export function productColumns(): CsvColumn[] {
  return [...CSV_COLUMNS]
}

// Cells go into the sheet as the type they actually are. Writing a price as the
// string "100" makes a text cell, which Sheets shows as '100 and refuses to sum,
// sort or chart - so numeric and boolean columns are converted, and everything
// else (sku and barcode included, since those may carry leading zeros) stays text.
function typedCell(column: CsvColumn, value: string): CellValue {
  if (value === '') return ''
  if (NUMERIC_CSV_COLUMNS.includes(column)) {
    const n = Number(value)
    // isFinite, not !isNaN: Infinity/-Infinity are not NaN but serialise to JSON
    // null, which values.update reads as "leave the existing cell", silently
    // keeping a stale sheet value. Fall back to the raw text instead.
    return Number.isFinite(n) ? n : value
  }
  if (BOOLEAN_CSV_COLUMNS.includes(column)) {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === 'false') return lower === 'true'
  }
  return value
}

// Build the Products grid: header row + one row per (non-hidden) product, from
// the same row builder the shop's CSV export uses - one format, one source, so
// the sheet cannot quietly fall behind the CSV again. We assemble the grid
// directly rather than round-tripping through CSV text: the write is RAW, so
// shop's formula-injection guard (which prefixes a leading apostrophe) is both
// redundant and would show the owner a stray ' in their cells.
export async function buildProductsGrid(): Promise<CellValue[][]> {
  const rows = await buildProductCsvRows()
  const columns = productColumns()

  // Product-level attribute columns (and any other module's product fields),
  // appended after the fixed columns - the Products-tab twin of the extra-field
  // columns the Variations tab carries. Each provider contributes a set that
  // varies per product, so the header is the union of every column label seen, in
  // first-seen order, and a product without a given column leaves its cell blank.
  const providers = await resolveProductFieldProviders()
  const bySlug = await getProductsBySlugs(rows.map((r) => r.slug))
  const idBySlug = new Map(rows.map((r) => [r.slug, bySlug.get(r.slug)?.id]).filter((e): e is [string, string] => !!e[1]))
  const productIds = [...new Set(idBySlug.values())]

  const fieldHeaderOrder: string[] = []
  const colsByProduct = new Map<string, Array<{ key: string; label: string }>>()
  const valuesByProduct = new Map<string, Record<string, string>>()
  if (providers.length > 0 && productIds.length > 0) {
    for (const productId of productIds) {
      const cols: Array<{ key: string; label: string }> = []
      for (const { provider } of providers) {
        for (const c of await provider.listColumns(productId)) {
          // Two providers (or two keys) can present the same visible label. A
          // sheet column is addressed by its label on the way back in (Pull hands
          // providers a row keyed by header text), so two same-labelled columns
          // cannot round-trip - the second would read the first's value. We
          // therefore merge deterministically on first-seen label (provider order
          // is stable) and warn, rather than silently emit an ambiguous column.
          if (cols.some((existing) => existing.label === c.label && existing.key !== c.key)) {
            console.warn(`[google-sheet-products-for-shop] duplicate product-field label "${c.label}" - keeping the first; give the fields distinct labels to sync both.`)
            continue
          }
          cols.push({ key: c.key, label: c.label })
          if (!fieldHeaderOrder.includes(c.label)) fieldHeaderOrder.push(c.label)
        }
      }
      colsByProduct.set(productId, cols)
    }
    for (const { provider } of providers) {
      const got = await provider.getValues(productIds)
      for (const [productId, rec] of Object.entries(got)) {
        valuesByProduct.set(productId, { ...(valuesByProduct.get(productId) ?? {}), ...rec })
      }
    }
  }

  const header: CellValue[] = [...columns.map((c) => c as CellValue), ...fieldHeaderOrder]
  const grid: CellValue[][] = [header]
  for (const row of rows) {
    const base = columns.map((c) => typedCell(c, row[c] ?? ''))
    const productId = idBySlug.get(row.slug)
    const cols = productId ? colsByProduct.get(productId) ?? [] : []
    const values = productId ? valuesByProduct.get(productId) ?? {} : {}
    // Attribute/extra-field columns have no fixed type: a numeric one must go in
    // as a real number, not the string "100" (which Sheets stores as a text cell,
    // shows as '100, and which defeats formula preservation). coerceOpenCell keeps
    // a genuine code like "0100" as text - see numeric-cell.ts.
    const fieldCells: CellValue[] = fieldHeaderOrder.map((label) => {
      const col = cols.find((c) => c.label === label)
      return coerceOpenCell(col ? values[col.key] ?? '' : '')
    })
    grid.push([...base, ...fieldCells])
  }
  return grid
}

// A product row is identified by SKU, falling back to slug when it has none -
// the same order Pull matches a sheet row to a product in, so the two directions
// agree on what "the same row" means.
const PRODUCT_KEYS = [['sku'], ['slug']]

// The Products header is a closed set, so a column beyond the pushed grid can be
// told apart from one the owner added themselves with certainty.
const PRODUCT_COLUMN_NAMES: ReadonlySet<string> = new Set(CSV_COLUMNS)

// DB -> Products tab. Returns the number of product rows written (excl. header)
// and how many of the owner's formulas survived.
export async function pushProductsTab(
  spreadsheetId: string
): Promise<{ rowCount: number; preservedFormulas: number }> {
  const grid = await buildProductsGrid()
  const result = await pushGrid({
    spreadsheetId,
    tab: TAB.PRODUCTS,
    grid,
    keyStrategies: PRODUCT_KEYS,
    ownsColumn: (header) => PRODUCT_COLUMN_NAMES.has(header),
  })
  // Dropdowns for type/status/out_of_stock_behaviour and the recommendation
  // modes, positioned for the full column layout.
  await applyProductsValidation(spreadsheetId, productColumns())
  return result
}
