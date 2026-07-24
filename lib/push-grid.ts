import {
  readGridWithFormulas,
  writeGrid,
  writeRawCells,
  clearRange,
  writeFormulaRuns,
  batchUpdate,
  getSheetIds,
  columnLetter,
  type CellValue,
} from '@/modules/google-sheet-products-for-shop/lib/sheets'
import {
  orderColumnsLikeSheet,
  orderRowsLikeSheet,
  layoutRowsAtSheetPositions,
  ownerColumnStart,
  spliceBlankColumns,
  planFormulaPreservation,
  toFormulaRuns,
  valuesMatch,
  type KeyStrategy,
} from '@/modules/google-sheet-products-for-shop/lib/formula-preserve'

// Writing one tab on a Push.
//
// This used to be clearTab + writeGrid, which wiped the entire tab - the owner's
// formulas, and any column they had added to the right of the catalogue with it.
// Now the write is confined to the rectangle the catalogue actually occupies, and
// the owner's own rows-below and columns-right are kept aligned with it:
//
//   1. If the grid has WIDENED into the owner's columns (a new attribute column,
//      say), blank columns are inserted so those columns shift RIGHT instead of
//      being overwritten (writeGrid at A1 would otherwise land the new column
//      straight on top of the owner's first one).
//   2. If the owner has columns of their own to the right, deleted products leave
//      a blank row IN PLACE rather than compacting the catalogue up - otherwise
//      every note beside a row below the deletion would end up against the wrong
//      product. With no owner columns the catalogue compacts as before (tidier,
//      and the only cost is a formula dropped on a row that genuinely moved).
//   3. Surviving formulas the database still agrees with are written back, and
//      any whose result no longer matches (a precedent changed in the same push)
//      are flattened to the plain value so the cell never DISPLAYS a number
//      different from what the site sells at.

export type PushGridResult = { rowCount: number; preservedFormulas: number }

export async function pushGrid(params: {
  spreadsheetId: string
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
}): Promise<PushGridResult> {
  const { spreadsheetId, tab, keyStrategies, ownsColumn } = params

  // Read before writing. A failure here is not swallowed: it would silently turn
  // formula preservation off AND skip the stale-row clear below, leaving orphan
  // rows from deleted products in the tab. The read uses the same credentials as
  // the write that follows, so anything that breaks it breaks the Push anyway.
  let oldGrid = await readGridWithFormulas(spreadsheetId, tab)

  // Columns first: reorder the new grid's open-ended tail to match the sheet the
  // owner is looking at, so a module update's changed attribute order cannot move
  // cells out from under their formulas (see orderColumnsLikeSheet).
  const columnsAligned = orderColumnsLikeSheet({ oldGrid, newGrid: params.grid, ownsColumn })
  const newWidth = columnsAligned[0]?.length ?? 0
  const newHeaderSet = new Set((columnsAligned[0] ?? []).map((c) => String(c).trim()).filter((h) => h !== ''))

  // (1) Widening into the owner's columns: insert blanks so they move right.
  // ownerColumnStart returns the owner's first column; if that sits UNDER the new
  // grid (index < newWidth) the write would overwrite it, so we open up exactly
  // enough room first and mirror the insert into the in-memory old grid.
  const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
  const collisionAt = ownerColumnStart(oldHeader, newHeaderSet, ownsColumn)
  if (collisionAt >= 0 && collisionAt < newWidth) {
    const insertCount = newWidth - collisionAt
    const sheetId = (await getSheetIds(spreadsheetId))[tab]
    if (sheetId !== undefined) {
      await batchUpdate(spreadsheetId, [
        { insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: collisionAt, endIndex: collisionAt + insertCount }, inheritFromBefore: false } },
      ])
      oldGrid = spliceBlankColumns(oldGrid, collisionAt, insertCount)
    }
  }

  // (2) Row layout. When the owner has columns of their own, hold each surviving
  // product at its existing sheet row (blank where one was removed) so those
  // columns stay aligned; otherwise compact as before.
  const hasOwnerColumns = ownerColumnStart(
    (oldGrid[0] ?? []).map((c) => c.value.trim()), newHeaderSet, ownsColumn,
  ) >= 0
  const grid = (hasOwnerColumns
    ? layoutRowsAtSheetPositions({ oldGrid, newGrid: columnsAligned, keyStrategies })
    : null) ?? orderRowsLikeSheet({ oldGrid, newGrid: columnsAligned, keyStrategies })

  const preserved = planFormulaPreservation({ oldGrid, newGrid: grid, keyStrategies })

  await writeGrid(spreadsheetId, tab, grid)

  const oldWidth = oldGrid.reduce((m, row) => Math.max(m, row.length), 0)
  const oldRows = oldGrid.length

  // Rows the old catalogue used that this one does not (only reachable when the
  // catalogue compacted - the position-preserving layout never shrinks the used
  // rows). Cleared across the pushed columns only.
  if (oldRows > grid.length && newWidth > 0) {
    await clearRange(spreadsheetId, tab, `A${grid.length + 1}:${columnLetter(newWidth - 1)}${oldRows}`)
  }

  // Columns the old catalogue used that this one does not - cost_price switched
  // off, an option pair that no product needs any more. Only columns we OWN are
  // cleared; the owner's own columns to the right are never touched. Grouped into
  // contiguous runs so this is one call in every realistic case.
  if (oldWidth > newWidth && oldRows > 0) {
    const oldHeaderNow = (oldGrid[0] ?? []).map((c) => c.value.trim())
    const lastRow = Math.max(oldRows, grid.length)
    let runStart = -1
    for (let c = newWidth; c <= oldWidth; c++) {
      const mine = c < oldWidth && ownsColumn(oldHeaderNow[c] ?? '')
      if (mine && runStart < 0) runStart = c
      if (!mine && runStart >= 0) {
        await clearRange(spreadsheetId, tab, `${columnLetter(runStart)}1:${columnLetter(c - 1)}${lastRow}`)
        runStart = -1
      }
    }
  }

  await writeFormulaRuns(spreadsheetId, tab, toFormulaRuns(preserved))

  // (3) Flatten any preserved formula whose post-push result no longer matches the
  // database value it stood in for. Preservation compared the formula's result
  // BEFORE this push; if a precedent cell changed in the same push, the restored
  // formula now re-evaluates to a different number - the exact silent-wrong-price
  // this module forbids. One extra read, only when formulas were actually kept.
  let flattened = 0
  if (preserved.length > 0) {
    const after = await readGridWithFormulas(spreadsheetId, tab)
    const fixes: Array<{ row: number; col: number; value: CellValue }> = []
    for (const cell of preserved) {
      const dbValue = grid[cell.row]?.[cell.col]
      if (dbValue === undefined) continue
      const nowValue = after[cell.row]?.[cell.col]?.value ?? ''
      if (!valuesMatch(nowValue, dbValue)) fixes.push({ row: cell.row, col: cell.col, value: dbValue })
    }
    if (fixes.length > 0) {
      await writeRawCells(spreadsheetId, tab, fixes)
      flattened = fixes.length
    }
  }

  return { rowCount: Math.max(grid.length - 1, 0), preservedFormulas: preserved.length - flattened }
}
