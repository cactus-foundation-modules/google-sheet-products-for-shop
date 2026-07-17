import { missingFormatColumns, type CsvColumn } from '@/modules/shop/lib/csv'

// Which required columns the sheet's Products header is missing. Empty = good.
// Drives the plain-English refusal on Pull ("your sheet is missing: price, name").
export function missingProductsColumns(grid: string[][]): CsvColumn[] {
  return missingFormatColumns(grid[0] ?? [])
}

// Structural CSV escaping only - NOT shop's toCsvField. toCsvField prefixes a
// leading apostrophe onto cells starting with = + - @ as an Excel formula-
// injection guard; that guard is for a CSV a human opens, but this text is fed
// straight into processImportJob, which would then store the stray apostrophe.
// Here the grid values ARE the truth, so we escape for parseCsv and nothing else.
function escapeCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// Grid (from the sheet) -> CSV text that shop's parseCsv reads back cell-for-cell.
export function gridToImportCsv(grid: string[][]): string {
  return grid.map((row) => row.map(escapeCell).join(',')).join('\r\n')
}

// Every non-empty sku present in the Products grid. Used to work out which shop
// products are absent from the sheet (archive candidates) and to refuse
// archiving a sku that is in fact still on the sheet.
export function extractSheetSkus(grid: string[][]): Set<string> {
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const skuCol = header.indexOf('sku')
  const skus = new Set<string>()
  if (skuCol < 0) return skus
  for (let r = 1; r < grid.length; r++) {
    const sku = (grid[r]?.[skuCol] ?? '').trim()
    if (sku) skus.add(sku)
  }
  return skus
}
