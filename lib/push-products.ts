import { CSV_COLUMNS, NUMERIC_CSV_COLUMNS, BOOLEAN_CSV_COLUMNS, type CsvColumn } from '@/modules/shop/lib/csv'
import { buildProductCsvRows } from '@/modules/shop/lib/csv-rows'
import { type CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { TAB, applyProductsValidation } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// The Products header, minus cost_price when the owner has hidden their margins.
// Dropping the column (rather than blanking it) is deliberate: a blank column on
// Pull would null every product's cost price; an absent column leaves it alone.
export function productColumns(includeCostPrice: boolean): CsvColumn[] {
  return CSV_COLUMNS.filter((c) => includeCostPrice || c !== 'cost_price')
}

// Cells go into the sheet as the type they actually are. Writing a price as the
// string "100" makes a text cell, which Sheets shows as '100 and refuses to sum,
// sort or chart - so numeric and boolean columns are converted, and everything
// else (sku and barcode included, since those may carry leading zeros) stays text.
function typedCell(column: CsvColumn, value: string): CellValue {
  if (value === '') return ''
  if (NUMERIC_CSV_COLUMNS.includes(column)) {
    const n = Number(value)
    return Number.isNaN(n) ? value : n
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
export async function buildProductsGrid(includeCostPrice: boolean): Promise<CellValue[][]> {
  const rows = await buildProductCsvRows()
  const columns = productColumns(includeCostPrice)
  const grid: CellValue[][] = [columns.map((c) => c as CellValue)]
  for (const row of rows) grid.push(columns.map((c) => typedCell(c, row[c] ?? '')))
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
  spreadsheetId: string,
  includeCostPrice: boolean
): Promise<{ rowCount: number; preservedFormulas: number }> {
  const grid = await buildProductsGrid(includeCostPrice)
  const result = await pushGrid({
    spreadsheetId,
    tab: TAB.PRODUCTS,
    grid,
    keyStrategies: PRODUCT_KEYS,
    ownsColumn: (header) => PRODUCT_COLUMN_NAMES.has(header),
  })
  // Dropdowns for type/status/out_of_stock_behaviour and the recommendation
  // modes, positioned for this exact column layout (cost_price may or may not
  // be present).
  await applyProductsValidation(spreadsheetId, productColumns(includeCostPrice))
  return result
}
