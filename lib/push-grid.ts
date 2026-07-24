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
//   2. Products that have left the catalogue have their sheet ROW deleted, not
//      just their cells blanked. The pushed rows below a deletion move up either
//      way; deleting the whole row is what makes the owner's own columns move up
//      with them, instead of leaving every note beside the wrong product. Any row
//      left over from before this existed - blank in every column, pushed and
//      owner's alike - is swept away the same way, since there is nothing on it
//      to lose.
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
  let sheetId: number | undefined
  if (collisionAt >= 0 && collisionAt < newWidth) {
    const insertCount = newWidth - collisionAt
    sheetId = (await getSheetIds(spreadsheetId))[tab]
    if (sheetId !== undefined) {
      await batchUpdate(spreadsheetId, [
        { insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: collisionAt, endIndex: collisionAt + insertCount }, inheritFromBefore: false } },
      ])
      oldGrid = spliceBlankColumns(oldGrid, collisionAt, insertCount)
    }
  }

  // (2) Delete the rows of products that have left the catalogue. Deleting the
  // whole row (rather than blanking it, or letting the pushed cells compact on
  // their own) is what carries the owner's columns up with the catalogue, so a
  // note stays beside its own product. Bottom-up, so each delete cannot shift the
  // indices of the ones still to apply.
  //
  // Folded into the same sweep: rows blank across the WHOLE row (pushed columns
  // AND the owner's) left over from before row deletion existed - a v0.1.33 Push
  // blanked a deleted product's pushed cells in place rather than removing the
  // row, and one with nothing of the owner's on it is a pure gap. Checked across
  // every column, so a row the owner has written anything into - a note, a
  // formula, anything - is never touched here.
  const doomedRows = [...new Set([
    ...planDeletedSheetRows({ oldGrid, newGrid: columnsAligned, keyStrategies }),
    ...planFullyBlankRows(oldGrid),
  ])]
  if (doomedRows.length > 0) {
    if (sheetId === undefined) sheetId = (await getSheetIds(spreadsheetId))[tab]
    if (sheetId !== undefined) {
      const id = sheetId
      await batchUpdate(spreadsheetId, toDescendingRowRanges(doomedRows).map((range) => ({
        deleteDimension: { range: { sheetId: id, dimension: 'ROWS', startIndex: range.start, endIndex: range.end } },
      })))
      oldGrid = removeRows(oldGrid, doomedRows)
    }
  }

  // Rows now line up one-for-one with the sheet, so the ordering pass simply
  // holds each surviving product where the owner already has it and appends
  // anything genuinely new at the bottom.
  const grid = orderRowsLikeSheet({ oldGrid, newGrid: columnsAligned, keyStrategies })

  const preserved = planFormulaPreservation({ oldGrid, newGrid: grid, keyStrategies })

  await writeGrid(spreadsheetId, tab, grid)

  const oldWidth = oldGrid.reduce((m, row) => Math.max(m, row.length), 0)
  const oldRows = oldGrid.length

  // Rows the old catalogue used that this one does not - what is left after the
  // row deletions above (a row with no usable identity is never deleted, so it
  // can still be orphaned down here). Cleared across the pushed columns only.
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
