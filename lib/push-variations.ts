import { exportVariationsCsv } from '@/modules/shop-variations/lib/csv'
import { parseCsv } from '@/modules/shop/lib/csv'
import { clearTab, writeGrid } from '@/modules/google-sheet-products-for-shop/lib/sheets'
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

// DB -> Variations tab. Returns the number of variant rows written (excl. header).
export async function pushVariationsTab(spreadsheetId: string): Promise<{ rowCount: number }> {
  const grid = await buildVariationsGrid()
  await clearTab(spreadsheetId, TAB.VARIATIONS)
  await writeGrid(spreadsheetId, TAB.VARIATIONS, grid)
  return { rowCount: Math.max(grid.length - 1, 0) }
}
