import {
  readGridsWithFormulasBatch,
  writeGridsBatch,
  batchClearRanges,
  writeRawCells,
  writeFormulaRuns,
  batchUpdate,
  getSheetIds,
  columnLetter,
  type CellValue,
  type SheetCell,
} from '@/modules/google-sheet-products-for-shop/lib/sheets'
import {
  orderColumnsLikeSheet,
  orderRowsLikeSheet,
  ownerColumnStart,
  spliceBlankColumns,
  planDeletedSheetRows,
  planFullyBlankRows,
  removeRows,
  toDescendingRowRanges,
  planFormulaPreservation,
  toFormulaRuns,
  valuesMatch,
  type KeyStrategy,
  type PreservedCell,
} from '@/modules/google-sheet-products-for-shop/lib/formula-preserve'

// Writing tabs on a Push - MANY AT A TIME.
//
// This used to be one function writing one tab: a read, a write, and up to four
// more calls, per tab. Google's quota is sixty reads and sixty writes a minute,
// so a catalogue of a couple of hundred variation tabs spent most of a Push
// queuing for quota rather than pushing. The planning is unchanged and still
// strictly per-tab (see planTabPush below); only the transport is batched:
//
//   - ONE spreadsheets.get reads the current grid+formulas of every tab in the
//     batch (readGridsWithFormulasBatch - one read-quota token per URL-full).
//   - ONE spreadsheets.batchUpdate applies every tab's structural changes
//     (column inserts, row deletes). Requests are applied in order and the call
//     is atomic - all or none - so a re-run never half-applies a shift.
//   - ONE values.batchUpdate writes every tab's grid.
//   - ONE values.batchClear sweeps every tab's stale rows and columns.
//   - ONE values.batchUpdate restores every tab's surviving formulas.
//   - ONE spreadsheets.get + ONE values.batchUpdate verify and flatten, and only
//     when formulas were actually kept somewhere.
//
// A tab whose sheet content already equals what the push would write - every
// pushed cell matching, nothing to insert, delete or clear - is SKIPPED outright:
// no write, no clear, and any owner formula on it survives untouched rather than
// being flattened and restored. On the typical push, where a handful of products
// changed since last time, most tabs take this path.
//
// Everything the single-tab version guaranteed still holds per tab: the write is
// confined to the rectangle the catalogue occupies, rows and columns take the
// sheet's existing order, widening inserts columns rather than overwriting the
// owner's, departed products lose their whole row, and a preserved formula whose
// post-push result disagrees with the database is flattened to the plain value.

export type PushGridResult = {
  rowCount: number
  preservedFormulas: number
  // The header actually written, which is the SHEET's column order rather than
  // the export's (see orderColumnsLikeSheet). Anything addressing a column by
  // index afterwards - the Products dropdowns - has to work off this, not off
  // the canonical list, or it lands on whichever column the owner moved there.
  header: string[]
  // True when the tab already held exactly this content and nothing was written.
  skipped: boolean
}

export type TabPushInput = {
  tab: string
  // Rebuilt from the database. Data rows are re-ordered to match the sheet's
  // existing row order before writing - the database gives no stable export
  // order, and a row that moves loses its formulas.
  grid: CellValue[][]
  // How to identify a row, in priority order - see formula-preserve.ts.
  keyStrategies: KeyStrategy[]
  // Was this old header one of ours? Columns that answer true are cleared when
  // the grid gets narrower and are never mistaken for the owner's own; everything
  // else to the right is the owner's and is left alone. Products can answer this
  // exactly (the CSV column names are a closed set). Variations cannot for the
  // columns a removed module used to contribute, so one of those can be left
  // behind as a stale column - harmless, since Pull ignores columns it does not
  // recognise.
  ownsColumn: (header: string) => boolean
}

// Everything one tab needs done, decided before anything is written. Pure - the
// unit tests drive this directly.
export type TabPushPlan = {
  tab: string
  // Insert this many blank columns at this index BEFORE writing, so a widened
  // grid shifts the owner's columns right instead of overwriting them.
  insert: { at: number; count: number } | null
  // Whole sheet rows to delete (0-based), already merged: departed products plus
  // fully blank leftovers.
  doomedRows: number[]
  // The grid to write: columns in the sheet's order, rows in the sheet's order.
  grid: CellValue[][]
  preserved: PreservedCell[]
  // A1 ranges (within the tab) whose stale content must be cleared. Only ranges
  // that actually hold something - clearing blank cells is a wasted write.
  clears: string[]
  // Nothing to do: the tab already holds exactly this content.
  skip: boolean
}

// Is any cell in the given rectangle of the old grid non-blank (a value or a
// formula)? Decides whether a clear range is worth a write at all.
function rectHasContent(oldGrid: SheetCell[][], rowStart: number, rowEnd: number, colStart: number, colEnd: number): boolean {
  for (let r = rowStart; r < rowEnd; r++) {
    const row = oldGrid[r] ?? []
    for (let c = colStart; c < colEnd; c++) {
      const cell = row[c]
      if (cell && (cell.value.trim() !== '' || cell.formula !== null)) return true
    }
  }
  return false
}

// Does the sheet already hold exactly what this push would leave behind? Checked
// over the pushed rectangle only. A formula cell passes on its EVALUATED value -
// skipping leaves it alive, which is strictly better than the write path's
// flatten-and-restore. An error cell never passes: its value is untrustworthy
// and the write path would replace it.
function sheetAlreadyMatches(oldGrid: SheetCell[][], grid: CellValue[][], width: number): boolean {
  for (let r = 0; r < grid.length; r++) {
    const oldRow = oldGrid[r] ?? []
    const newRow = grid[r] ?? []
    for (let c = 0; c < width; c++) {
      const oldCell = oldRow[c]
      if (oldCell?.error) return false
      if (!valuesMatch(oldCell?.value ?? '', newRow[c] ?? '')) return false
    }
  }
  return true
}

// Decide everything one tab needs, without touching the network. `oldGrid` is
// the tab as it currently stands (from the batched read); the returned plan's
// grid is what to write and where to clear. Identical decisions to the old
// single-tab pushGrid, in the same order.
export function planTabPush(input: TabPushInput, oldGridIn: SheetCell[][]): TabPushPlan {
  const { tab, keyStrategies, ownsColumn } = input
  let oldGrid = oldGridIn

  // Columns first: reorder the new grid to match the sheet the owner is looking
  // at, so neither a module update's changed attribute order nor a column the
  // owner has dragged somewhere else moves cells out from under their formulas
  // (see orderColumnsLikeSheet). The sheet's order is what gets written back.
  const columnsAligned = orderColumnsLikeSheet({ oldGrid, newGrid: input.grid })
  const newWidth = columnsAligned[0]?.length ?? 0
  const newHeaderSet = new Set((columnsAligned[0] ?? []).map((c) => String(c).trim()).filter((h) => h !== ''))

  // Widening into the owner's columns: plan blank-column inserts so those columns
  // shift RIGHT instead of being overwritten, and mirror the insert into the
  // in-memory old grid so everything downstream sees the post-insert sheet.
  const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
  const collisionAt = ownerColumnStart(oldHeader, newHeaderSet, ownsColumn)
  let insert: TabPushPlan['insert'] = null
  if (collisionAt >= 0 && collisionAt < newWidth) {
    insert = { at: collisionAt, count: newWidth - collisionAt }
    oldGrid = spliceBlankColumns(oldGrid, insert.at, insert.count)
  }

  // Rows of products that have left the catalogue, plus fully blank leftovers.
  // Mirrored into the in-memory old grid the same way.
  const doomedRows = [...new Set([
    ...planDeletedSheetRows({ oldGrid, newGrid: columnsAligned, keyStrategies }),
    ...planFullyBlankRows(oldGrid),
  ])]
  if (doomedRows.length > 0) oldGrid = removeRows(oldGrid, doomedRows)

  // Rows now line up one-for-one with the sheet, so the ordering pass simply
  // holds each surviving product where the owner already has it and appends
  // anything genuinely new at the bottom.
  const grid = orderRowsLikeSheet({ oldGrid, newGrid: columnsAligned, keyStrategies })

  const preserved = planFormulaPreservation({ oldGrid, newGrid: grid, keyStrategies })

  const oldWidth = oldGrid.reduce((m, row) => Math.max(m, row.length), 0)
  const oldRows = oldGrid.length
  const clears: string[] = []

  // Rows the old catalogue used that this one does not - what is left after the
  // row deletions above (a row with no usable identity is never deleted, so it
  // can still be orphaned down here). Cleared across the pushed columns only,
  // and only when something is actually there.
  if (oldRows > grid.length && newWidth > 0 && rectHasContent(oldGrid, grid.length, oldRows, 0, newWidth)) {
    clears.push(`A${grid.length + 1}:${columnLetter(newWidth - 1)}${oldRows}`)
  }

  // Columns the old catalogue used that this one does not - cost_price switched
  // off, an option pair that no product needs any more. Only columns we OWN are
  // cleared; the owner's own columns to the right are never touched. Grouped into
  // contiguous runs, and a run that is already blank is not worth a write.
  if (oldWidth > newWidth && oldRows > 0) {
    const oldHeaderNow = (oldGrid[0] ?? []).map((c) => c.value.trim())
    const lastRow = Math.max(oldRows, grid.length)
    let runStart = -1
    for (let c = newWidth; c <= oldWidth; c++) {
      const mine = c < oldWidth && ownsColumn(oldHeaderNow[c] ?? '')
      if (mine && runStart < 0) runStart = c
      if (!mine && runStart >= 0) {
        if (rectHasContent(oldGrid, 0, lastRow, runStart, c)) {
          clears.push(`${columnLetter(runStart)}1:${columnLetter(c - 1)}${lastRow}`)
        }
        runStart = -1
      }
    }
  }

  const skip = insert === null && doomedRows.length === 0 && clears.length === 0
    && sheetAlreadyMatches(oldGrid, grid, newWidth)

  return { tab, insert, doomedRows, grid, preserved, clears, skip }
}

// Push many tabs in one batched pass. Results come back in input order. Safe to
// re-run in full: every step re-reads the sheet fresh and re-plans, so a re-run
// after a crash just re-writes the same cells (or skips them).
export async function pushGrids(spreadsheetId: string, inputs: TabPushInput[]): Promise<PushGridResult[]> {
  if (inputs.length === 0) return []

  // Read before writing, all tabs in one URL-full. A failure here is not
  // swallowed: it would silently turn formula preservation off AND skip the
  // stale-row clears, leaving orphan rows from deleted products behind. The read
  // uses the same credentials as the writes that follow, so anything that breaks
  // it breaks the Push anyway.
  const oldGrids = await readGridsWithFormulasBatch(spreadsheetId, inputs.map((i) => i.tab))

  const plans = inputs.map((input) => planTabPush(input, oldGrids[input.tab] ?? []))

  // Structural changes for every tab in one atomic batchUpdate: each tab's
  // column insert first, then its row deletes bottom-up (so no delete shifts the
  // indices of one still to apply). Different tabs are independent sheets, so
  // interleaving order between tabs does not matter. A tab whose sheetId cannot
  // be found (renamed mid-push) skips its structural work, exactly as the
  // single-tab path did - the value write below still lands.
  const structural = plans.filter((p) => p.insert !== null || p.doomedRows.length > 0)
  if (structural.length > 0) {
    const ids = await getSheetIds(spreadsheetId)
    const requests: unknown[] = []
    for (const plan of structural) {
      const sheetId = ids[plan.tab]
      if (sheetId === undefined) continue
      if (plan.insert) {
        requests.push({
          insertDimension: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: plan.insert.at, endIndex: plan.insert.at + plan.insert.count },
            inheritFromBefore: false,
          },
        })
      }
      for (const range of toDescendingRowRanges(plan.doomedRows)) {
        requests.push({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: range.start, endIndex: range.end } } })
      }
    }
    await batchUpdate(spreadsheetId, requests)
  }

  const active = plans.filter((p) => !p.skip)

  await writeGridsBatch(spreadsheetId, active.map((p) => ({ tab: p.tab, values: p.grid })))

  await batchClearRanges(spreadsheetId, active.flatMap((p) => p.clears.map((a1) => ({ tab: p.tab, a1 }))))

  await writeFormulaRuns(spreadsheetId, active.flatMap((p) => toFormulaRuns(p.preserved).map((run) => ({ ...run, tab: p.tab }))))

  // Flatten any preserved formula whose post-push result no longer matches the
  // database value it stood in for. Preservation compared the formula's result
  // BEFORE this push; if a precedent cell changed in the same push, the restored
  // formula now re-evaluates to a different number - the exact silent-wrong-price
  // this module forbids. One extra read and at most one extra write for the whole
  // batch, and only when formulas were actually kept. Skipped tabs need none of
  // this: nothing was written, so nothing re-evaluated.
  const flattenedByTab = new Map<string, number>()
  const withFormulas = active.filter((p) => p.preserved.length > 0)
  if (withFormulas.length > 0) {
    const after = await readGridsWithFormulasBatch(spreadsheetId, withFormulas.map((p) => p.tab))
    const fixes: Array<{ tab: string; row: number; col: number; value: CellValue }> = []
    for (const plan of withFormulas) {
      const tabAfter = after[plan.tab] ?? []
      for (const cell of plan.preserved) {
        const dbValue = plan.grid[cell.row]?.[cell.col]
        if (dbValue === undefined) continue
        const nowValue = tabAfter[cell.row]?.[cell.col]?.value ?? ''
        if (!valuesMatch(nowValue, dbValue)) {
          fixes.push({ tab: plan.tab, row: cell.row, col: cell.col, value: dbValue })
          flattenedByTab.set(plan.tab, (flattenedByTab.get(plan.tab) ?? 0) + 1)
        }
      }
    }
    await writeRawCells(spreadsheetId, fixes)
  }

  return plans.map((plan) => ({
    rowCount: Math.max(plan.grid.length - 1, 0),
    preservedFormulas: plan.preserved.length - (flattenedByTab.get(plan.tab) ?? 0),
    header: (plan.grid[0] ?? []).map((c) => String(c).trim()),
    skipped: plan.skip,
  }))
}

// The single-tab push, now a one-entry batch. Products still comes through here.
export async function pushGrid(params: TabPushInput & { spreadsheetId: string }): Promise<PushGridResult> {
  const { spreadsheetId, ...input } = params
  const [result] = await pushGrids(spreadsheetId, [input])
  return result!
}
