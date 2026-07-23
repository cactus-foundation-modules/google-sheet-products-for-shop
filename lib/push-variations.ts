import { exportVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { parseCsv } from '@/modules/shop/lib/csv'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { type CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// The variation columns that hold a number, not text. They go into the sheet as
// JS numbers for the same reason the Products tab's do (see push-products.ts): a
// numeric string written under RAW lands as a TEXT cell, which Sheets shows as
// '123 and refuses to sum, sort or chart. Worse, a text price also defeats
// formula-preservation - valuesMatch compares a text new-value character for
// character with no float tolerance, so "=B2" evaluating to 15.000000000000002
// never equals the string "15" and the owner's formula is replaced on every Push
// even when the price has not moved. Sending the real number fixes both.
// SKU, Barcode and Variant ID stay text: they can carry leading zeros or be ids.
const NUMERIC_VARIATION_COLUMNS: ReadonlySet<string> = new Set([
  'Price', 'Sale Price', 'RRP', 'Trade Price', 'Cost Price', 'Stock', 'Weight',
])

// Variations are the one tab that goes DB -> text -> grid rather than being built
// directly: exportVariationsCsv already emits one row per variant with the option
// pairs widened to the widest product, so round-tripping through parseCsv gets
// that dynamic width for free and duplicates none of the logic.
export async function buildVariationsGrid(): Promise<CellValue[][]> {
  const csv = await exportVariationsCsv()
  const grid = parseCsv(csv)
  // exportVariationsCsv serialises via toCsvRow, which prefixes a single ' onto
  // any cell starting with = + - @ (an Excel formula-injection guard). We write
  // RAW so nothing ever evaluates - strip that one guard apostrophe back off so
  // the owner sees their real value. Only strip when the next char is one the
  // guard actually targets, so a value that genuinely begins with ' is untouched.
  const guard = /[=+\-@\t\r]/
  const header = (grid[0] ?? []).map((h) => h.trim())
  const numeric = header.map((h) => NUMERIC_VARIATION_COLUMNS.has(h))
  return grid.map((row, r) =>
    row.map((cell, c) => {
      const unguarded = cell.length > 1 && cell[0] === "'" && guard.test(cell[1]!) ? cell.slice(1) : cell
      // The header row and every text column stay strings. A blank numeric cell
      // stays blank (a variant with no RRP is not one priced at zero).
      if (r === 0 || !numeric[c] || unguarded === '') return unguarded
      const n = Number(unguarded)
      return Number.isNaN(n) ? unguarded : n
    })
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
    keyStrategies: variationKeys((grid[0] ?? []).map(String)),
    ownsColumn: (header) => FIXED_VARIATION_COLUMNS.has(header) || OPTION_PAIR.test(header),
  })
}
