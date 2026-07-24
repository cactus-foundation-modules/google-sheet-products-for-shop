import type { CellValue, SheetCell, FormulaRun } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { canonicalNumber } from '@/modules/google-sheet-products-for-shop/lib/numeric-cell'

// Deciding which of the owner's formulas may survive a Push.
//
// A Push rebuilds the whole grid from the database and writes it over the tab. A
// formula in a pushed cell is therefore about to be replaced by a plain value.
// It is kept only when we can prove that keeping it changes nothing: the formula
// currently evaluates to exactly the value the database is about to write.
//
// THE RULE IS DELIBERATELY STRICT. A formula's cell references are written back
// as literal text, so they do not shift the way a copy-paste would: move a row
// and "=B5*1.2" still says B5, now pointing at a different product. There is no
// safe way to rewrite references without a real formula parser, and a parser that
// gets it subtly wrong would publish wrong prices in silence. So a formula is
// preserved only when its row index, its column index and its computed result are
// all unchanged. Insert a product halfway up the catalogue and every formula
// below it reverts to a plain value on the next Push. That is the intended
// behaviour: the owner loses a formula, never the correct number.
//
// Formulas in columns to the RIGHT of the pushed grid are a different matter -
// Push never writes there and no longer clears there either, so those survive
// untouched. That is the place for a helper column or an ARRAYFORMULA.

export type PreservedCell = { row: number; col: number; formula: string }

// How to identify a row, in priority order. Each entry is a group of column
// names; the first group whose cells are all non-empty forms the row's key. For
// Products that is ['sku'] then ['slug'] - the same fallback Pull uses to match a
// sheet row to a product.
export type KeyStrategy = string[]

// Numbers coming back from a formula are rarely bit-identical to the number the
// database holds: "=12.5*1.2" evaluates to 15.000000000000002, and a strict
// comparison against 15 would discard every price formula on every Push. This is
// a relative tolerance, so it holds at both £3 and £30,000.
const NUMERIC_TOLERANCE = 1e-9

function parseNumber(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function numbersMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
}

// Does the formula's current result equal the value the database is about to
// write? Compared by the type of the NEW value, since that is the type the cell
// would end up holding.
export function valuesMatch(oldValue: string, newValue: CellValue): boolean {
  if (typeof newValue === 'number') {
    const old = parseNumber(oldValue)
    return old !== null && numbersMatch(old, newValue)
  }
  if (typeof newValue === 'boolean') {
    return oldValue.trim().toLowerCase() === String(newValue)
  }
  // A string new-value that is a CANONICAL number ("15", "15.5") is compared
  // numerically, with the same float tolerance the numeric branch above uses. This
  // is what lets a formula survive over an open-ended column (a custom attribute)
  // whose value happens to be a plain number but reached the grid as text: "=B2*1.2"
  // coming out 15.000000000000002 still matches a pushed "15".
  //
  // A string that is NOT a canonical number is compared as text, with no numeric
  // leniency. sku, barcode and slug live here, and in a barcode "0100" is not 100,
  // nor is a preformatted "100.0" the number 100 - a numeric fallback would call
  // those equal and preserve a formula over a value that had genuinely changed.
  // canonicalNumber returns null for exactly those (they do not round-trip), so
  // they fall through to the exact text compare.
  const canonical = canonicalNumber(newValue)
  if (canonical !== null) {
    const old = parseNumber(oldValue)
    if (old !== null && numbersMatch(old, canonical)) return true
  }
  return oldValue.trim() === newValue.trim()
}

function headerNames(row: readonly CellValue[]): string[] {
  return row.map((c) => String(c).trim())
}

// Resolve each key strategy (column NAMES) to column INDICES in this header,
// dropping any strategy whose columns the header does not all carry.
function resolveStrategyColumns(newHeader: string[], keyStrategies: KeyStrategy[]): number[][] {
  const strategies: number[][] = []
  for (const strategy of keyStrategies) {
    const cols = strategy.map((name) => newHeader.indexOf(name))
    if (cols.length > 0 && cols.every((i) => i >= 0)) strategies.push(cols)
  }
  return strategies
}

// Do the pushed columns line up with the sheet's? The old header may be WIDER
// (owner columns to the right) so only [0, newWidth) is checked, and a BLANK old
// column is allowed to sit under a new one - that is a genuinely new column with
// nothing to shift, not a relabelled one. A non-blank old label that differs is a
// real shift and fails the check (formulas/positions cannot be trusted).
function pushedColumnsAligned(oldHeader: string[], newHeader: string[]): boolean {
  for (let c = 0; c < newHeader.length; c++) {
    const old = oldHeader[c] ?? ''
    if (old !== '' && old !== newHeader[c]) return false
  }
  return true
}

// The first column that is genuinely the OWNER's - a non-empty header the pushed
// grid does not carry and the module does not own - or -1 when there is none.
// A relabelled/removed module column (ownsColumn true) is NOT owner data, so it
// does not count: only the owner's own additions do.
export function ownerColumnStart(
  oldHeader: string[],
  newHeaderSet: ReadonlySet<string>,
  ownsColumn: (header: string) => boolean,
): number {
  for (let c = 0; c < oldHeader.length; c++) {
    const h = oldHeader[c]
    if (h && !newHeaderSet.has(h) && !ownsColumn(h)) return c
  }
  return -1
}

// EVERY identity a row answers to - one per key strategy whose columns are all
// filled in, rather than just the first (which is what rowKey returns).
//
// Deletion is decided on ANY of these matching, not the priority key: a product
// whose SKU was cleared in the admin still matches on its slug, so it is
// recognised as "still in the catalogue" instead of being read as deleted and
// having its whole row (and the owner's notes beside it) removed.
function rowIdentities(values: string[], strategies: number[][]): string[] {
  const out: string[] = []
  for (let s = 0; s < strategies.length; s++) {
    const cols = strategies[s]!
    const parts: string[] = []
    let complete = true
    for (const col of cols) {
      const v = (values[col] ?? '').trim()
      if (v === '') { complete = false; break }
      parts.push(v)
    }
    if (complete) out.push(`${s} ${parts.join(' ')}`)
  }
  return out
}

// Which of the sheet's existing data rows belong to products that have left the
// catalogue. Returned as 0-based grid row indices, which are also the row indices
// deleteDimension takes. Empty when the pushed columns do not line up or no key
// strategy resolves - we never guess at deletion.
//
// The caller deletes these rows outright rather than blanking them, so that the
// owner's own columns to the right move up WITH the catalogue. Blanking in place
// (or simply letting the pushed rows compact while the owner's columns stayed
// put) is what left their notes beside the wrong product.
//
// A row with no usable identity at all - every key column blank - is NEVER
// deleted. That is a row the owner is part-way through typing, not a tombstone.
export function planDeletedSheetRows(params: {
  oldGrid: SheetCell[][]
  newGrid: CellValue[][]
  keyStrategies: KeyStrategy[]
}): number[] {
  const { oldGrid, newGrid, keyStrategies } = params
  if (oldGrid.length < 2 || newGrid.length < 1) return []

  const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
  const newHeader = headerNames(newGrid[0] ?? [])
  if (!pushedColumnsAligned(oldHeader, newHeader)) return []

  const strategies = resolveStrategyColumns(newHeader, keyStrategies)
  if (strategies.length === 0) return []

  const live = new Set<string>()
  for (let r = 1; r < newGrid.length; r++) {
    for (const id of rowIdentities((newGrid[r] ?? []).map((v) => String(v)), strategies)) live.add(id)
  }

  const doomed: number[] = []
  for (let r = 1; r < oldGrid.length; r++) {
    const ids = rowIdentities((oldGrid[r] ?? []).map((c) => c.value), strategies)
    if (ids.length === 0) continue // nothing to identify it by - leave it alone
    if (ids.some((id) => live.has(id))) continue // still in the catalogue
    doomed.push(r)
  }
  return doomed
}

// Drop the given 0-based row indices from a grid-with-formulas, mirroring a
// deleteDimension on the live sheet so the in-memory old grid still matches it.
export function removeRows(oldGrid: SheetCell[][], rows: number[]): SheetCell[][] {
  const drop = new Set(rows)
  return oldGrid.filter((_, i) => !drop.has(i))
}

// Contiguous [start, end) runs of the given row indices, ordered HIGHEST FIRST.
// Deleting from the bottom up means each deletion cannot shift the indices of the
// ones still to be applied.
export function toDescendingRowRanges(rows: number[]): Array<{ start: number; end: number }> {
  const sorted = [...new Set(rows)].sort((a, b) => a - b)
  const ranges: Array<{ start: number; end: number }> = []
  for (const r of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && r === last.end) { last.end = r + 1; continue }
    ranges.push({ start: r, end: r + 1 })
  }
  return ranges.reverse()
}

// Splice `count` blank columns into every row of a grid-with-formulas at `at`,
// mirroring an insertDimension on the live sheet so the in-memory old grid still
// matches it (used when a Push widens into the owner's columns - see push-grid).
export function spliceBlankColumns(oldGrid: SheetCell[][], at: number, count: number): SheetCell[][] {
  const blanks: SheetCell[] = Array.from({ length: count }, () => ({ formula: null, value: '', error: false }))
  return oldGrid.map((row) => {
    const copy = [...row]
    copy.splice(at, 0, ...blanks.map((b) => ({ ...b })))
    return copy
  })
}

// The row's identity, or null when no strategy applies (every candidate key
// column blank). A null key never matches, so such a row keeps no formulas.
function rowKey(values: string[], strategies: number[][]): string | null {
  for (let s = 0; s < strategies.length; s++) {
    const cols = strategies[s]!
    const parts: string[] = []
    let complete = true
    for (const col of cols) {
      const v = (values[col] ?? '').trim()
      if (v === '') {
        complete = false
        break
      }
      parts.push(v)
    }
    if (complete) return `${s} ${parts.join(' ')}`
  }
  return null
}

// Reorder the new grid's open-ended COLUMNS to match the order the sheet
// already has, so a column keeps its position (and the whole tab keeps its
// formulas) across a Push.
//
// The open-ended tail - attribute columns and other modules' extra fields - is
// built in "first seen" order, which is only as stable as the order products
// come out of the database. A module update changed that order once and the
// attribute blocks swapped places in the header; header compatibility is
// all-or-nothing, so that single shuffle flattened every formula on the tab.
// The sheet's existing order wins instead: tail labels the sheet already has
// keep their column, labels new to the sheet append at the end in export order.
//
// Only columns the module does NOT own may move. The fixed block's order is the
// module's to define (validation ranges are addressed by those indices), so a
// module-owned column outside the common prefix - a fixed column added or
// removed by an update - means the tab's shape genuinely changed: bail and let
// the push flatten formulas the documented way rather than guess.
export function orderColumnsLikeSheet(params: {
  oldGrid: SheetCell[][]
  newGrid: CellValue[][]
  ownsColumn: (header: string) => boolean
}): CellValue[][] {
  const { oldGrid, newGrid, ownsColumn } = params
  if (oldGrid.length < 1 || newGrid.length < 2) return newGrid

  const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
  const newHeader = headerNames(newGrid[0] ?? [])

  let prefix = 0
  while (prefix < newHeader.length && (oldHeader[prefix] ?? '') === newHeader[prefix]) prefix++
  if (prefix === newHeader.length) return newGrid

  const tail = newHeader.slice(prefix)
  if (tail.some((h) => ownsColumn(h))) return newGrid

  // Where each old tail label sits in the sheet; first occurrence wins, and a
  // position already taken by an earlier duplicate is not reused.
  const oldPos = new Map<string, number>()
  for (let c = prefix; c < oldHeader.length; c++) {
    const h = oldHeader[c] ?? ''
    if (h !== '' && !oldPos.has(h)) oldPos.set(h, c)
  }
  const used = new Set<number>()
  const decorated = tail.map((h, i) => {
    const p = oldPos.get(h)
    const pos = p !== undefined && !used.has(p) ? p : Number.MAX_SAFE_INTEGER
    if (p !== undefined) used.add(p)
    return { i, pos }
  })
  decorated.sort((a, b) => a.pos - b.pos || a.i - b.i)

  const order = [...Array.from({ length: prefix }, (_, i) => i), ...decorated.map((d) => prefix + d.i)]
  if (order.every((c, i) => c === i)) return newGrid
  return newGrid.map((row) => order.map((c) => row[c] ?? ''))
}

// Reorder the new grid's data rows to match the order the sheet already has,
// so a row keeps its position (and therefore its formulas) across a Push.
//
// The database does not promise a stable export order - the Variations export
// once shuffled two parents between runs because its id query had no ORDER BY -
// and the sheet's owner may also have sorted the tab themselves. Preservation is
// positional (row r is compared to row r), so any shift flattened every formula
// in the shifted rows even though no value had changed. Matching the sheet's
// existing order makes row position the sheet's own property: a row present in
// both grids stays exactly where the owner sees it, and only genuinely new rows
// append at the bottom, in export order.
//
// Rows are matched by the same key strategies preservation itself uses, against
// the same header-compatibility rule: if the pushed columns do not line up with
// the sheet's, the grid is returned untouched (preservation would refuse too).
export function orderRowsLikeSheet(params: {
  oldGrid: SheetCell[][]
  newGrid: CellValue[][]
  keyStrategies: KeyStrategy[]
}): CellValue[][] {
  const { oldGrid, newGrid, keyStrategies } = params
  if (oldGrid.length < 2 || newGrid.length < 2) return newGrid

  const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
  const newHeader = headerNames(newGrid[0] ?? [])
  if (!pushedColumnsAligned(oldHeader, newHeader)) return newGrid

  const strategies = resolveStrategyColumns(newHeader, keyStrategies)
  if (strategies.length === 0) return newGrid

  // First occurrence wins on a duplicate key, same as row matching would.
  const oldIndexByKey = new Map<string, number>()
  for (let r = 1; r < oldGrid.length; r++) {
    const key = rowKey((oldGrid[r] ?? []).map((c) => c.value), strategies)
    if (key !== null && !oldIndexByKey.has(key)) oldIndexByKey.set(key, r)
  }

  const dataRows = newGrid.slice(1).map((row, i) => {
    const key = rowKey(row.map((v) => String(v)), strategies)
    const oldIndex = key !== null ? oldIndexByKey.get(key) : undefined
    return { row, oldIndex: oldIndex ?? Number.MAX_SAFE_INTEGER, exportIndex: i }
  })
  // Stable sort: shared rows take the sheet's order, new rows keep the export's
  // order among themselves and go to the bottom.
  dataRows.sort((a, b) => a.oldIndex - b.oldIndex || a.exportIndex - b.exportIndex)
  return [newGrid[0]!, ...dataRows.map((d) => d.row)]
}

export function planFormulaPreservation(params: {
  oldGrid: SheetCell[][]
  newGrid: CellValue[][]
  keyStrategies: KeyStrategy[]
}): PreservedCell[] {
  const { oldGrid, newGrid, keyStrategies } = params
  if (oldGrid.length < 2 || newGrid.length < 2) return []

  const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
  const newHeader = headerNames(newGrid[0] ?? [])

  // Column positions must be identical for the same reason row positions must
  // be: a preserved "=B5*1.2" keeps pointing at column B whatever we do. The old
  // header may be WIDER (the owner's own columns sit to the right); only the
  // pushed columns have to line up (a blank old column under a new one is fine -
  // nothing referenced it).
  if (!pushedColumnsAligned(oldHeader, newHeader)) return []

  // Resolve each key strategy to column indices, dropping any whose columns the
  // header does not carry (cost_price hidden, an option pair that no longer
  // exists, and so on).
  const strategies = resolveStrategyColumns(newHeader, keyStrategies)
  if (strategies.length === 0) return []

  const preserved: PreservedCell[] = []
  const rowCount = Math.min(oldGrid.length, newGrid.length)
  for (let r = 1; r < rowCount; r++) {
    const oldRow = oldGrid[r]
    const newRow = newGrid[r]
    if (!oldRow || !newRow) continue

    const newKey = rowKey(newRow.map((v) => String(v)), strategies)
    if (newKey === null) continue
    if (rowKey(oldRow.map((c) => c.value), strategies) !== newKey) continue

    for (let c = 0; c < newRow.length; c++) {
      const old = oldRow[c]
      if (!old || old.formula === null || old.error) continue
      if (!valuesMatch(old.value, newRow[c]!)) continue
      preserved.push({ row: r, col: c, formula: old.formula })
    }
  }
  return preserved
}

// Collapse preserved cells into horizontal runs so the restore is a handful of
// ranges rather than one per cell. Input is in row-major order already.
export function toFormulaRuns(cells: PreservedCell[]): FormulaRun[] {
  const runs: FormulaRun[] = []
  let current: FormulaRun | null = null
  for (const cell of cells) {
    if (current && cell.row === current.row && cell.col === current.col + current.formulas.length) {
      current.formulas.push(cell.formula)
      continue
    }
    current = { row: cell.row, col: cell.col, formulas: [cell.formula] }
    runs.push(current)
  }
  return runs
}
