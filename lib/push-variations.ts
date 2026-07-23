import { exportVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { parseCsv } from '@/modules/shop/lib/csv'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// Variations are the one tab that goes DB -> text -> grid rather than being built
// directly: exportVariationsCsv already emits one row per variant with the option
// pairs widened to the widest product, so round-tripping through parseCsv gets
// that dynamic width for free and duplicates none of the logic.
export async function buildVariationsGrid(): Promise<string[][]> {
  const csv = await exportVariationsCsv()
  const grid = parseCsv(csv)
  // exportVariationsCsv serialises via toCsvRow, which prefixes a single ' onto
  // any cell starting with = + - @ (an Excel formula-injection guard). We write
  // RAW so nothing ever evaluates - strip that one guard apostrophe back off so
  // the owner sees their real value. Only strip when the next char is one the
  // guard actually targets, so a value that genuinely begins with ' is untouched.
  const guard = /[=+\-@\t\r]/
  return grid.map((row) =>
    row.map((cell) => (cell.length > 1 && cell[0] === "'" && guard.test(cell[1]!) ? cell.slice(1) : cell))
  )
}

// The Variations columns this module and shop-variations own between them.
// Anything else in the header is either a field another module contributes (the
// labels are arbitrary, so they cannot be listed here) or a column the owner
// added. Both are left alone.
const FIXED_VARIATION_COLUMNS: ReadonlySet<string> = new Set([
  'Parent Slug', 'Parent Name', 'Variant SKU', 'Price', 'Sale Price', 'RRP', 'Trade Price', 'Cost Price', 'Stock', 'Barcode', 'Supplier', 'Weight', 'Image', 'Variant ID',
])
const OPTION_PAIR = /^(Option|Value) \d+$/

// A variant row is identified by its Variant ID (the stable child product id the
// export writes), then by SKU where it has one, then by the parent slug plus its
// full set of option values - the same order the Variations importer matches in.
function variationKeys(header: string[]): string[][] {
  const optionCols = header.filter((h) => OPTION_PAIR.test(h))
  return [['Variant ID'], ['Variant SKU'], ['Parent Slug', ...optionCols]]
}

// DB -> Variations tab. Returns the number of variant rows written (excl. header)
// and how many of the owner's formulas survived.
export async function pushVariationsTab(spreadsheetId: string): Promise<{ rowCount: number; preservedFormulas: number }> {
  const grid = await buildVariationsGrid()
  return pushGrid({
    spreadsheetId,
    tab: TAB.VARIATIONS,
    grid,
    keyStrategies: variationKeys(grid[0] ?? []),
    ownsColumn: (header) => FIXED_VARIATION_COLUMNS.has(header) || OPTION_PAIR.test(header),
  })
}
