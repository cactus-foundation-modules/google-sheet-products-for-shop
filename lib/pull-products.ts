import { missingFormatColumns, type CsvColumn } from '@/modules/shop/lib/csv'

// Which required columns the sheet's Products header is missing. Empty = good.
// Drives the plain-English refusal on Pull ("your sheet is missing: price, name").
//
// `excluded` names the columns the owner has deliberately switched off (see
// lib/columns.ts). Those are absent by design, so a Pull must not refuse over
// them - it simply does not sync those fields, the same as any column the sheet
// does not carry.
export function missingProductsColumns(grid: string[][], excluded: readonly CsvColumn[] = []): CsvColumn[] {
  const off = new Set<string>(excluded)
  return missingFormatColumns(grid[0] ?? []).filter((c) => !off.has(c))
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
