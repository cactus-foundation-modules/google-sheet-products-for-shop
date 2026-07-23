import {
  readGridWithFormulas,
  writeGrid,
  clearRange,
  writeFormulaRuns,
  columnLetter,
  type CellValue,
} from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { planFormulaPreservation, toFormulaRuns, type KeyStrategy } from '@/modules/google-sheet-products-for-shop/lib/formula-preserve'

// Writing one tab on a Push.
//
// This used to be clearTab + writeGrid, which wiped the entire tab - the owner's
// formulas, and any column they had added to the right of the catalogue with it.
// Now the write is confined to the rectangle the catalogue actually occupies, and
// formulas whose result the database agrees with are put back afterwards.
//
// The sequence is three calls at most:
//   1. writeGrid   (RAW)          - the catalogue, values only
//   2. clearRange  (0-2 calls)    - rows and columns the old grid used and this
//                                   one does not
//   3. writeFormulaRuns (USER_ENTERED) - the surviving formulas, if any
//
// Between 1 and 3 a preserved cell briefly holds its own computed value, which is
// the same number the formula produces. A Push that fails in between leaves the
// sheet correct but plainer, never wrong.

export type PushGridResult = { rowCount: number; preservedFormulas: number }

export async function pushGrid(params: {
  spreadsheetId: string
  tab: string
  grid: CellValue[][]
  // How to identify a row, in priority order - see formula-preserve.ts.
  keyStrategies: KeyStrategy[]
  // Was this old header one of ours? Only columns that answer true are cleared
  // when the grid gets narrower; everything else to the right is the owner's and
  // is left alone. Products can answer this exactly (the CSV column names are a
  // closed set). Variations cannot for the columns a removed module used to
  // contribute, so one of those can be left behind as a stale column - harmless,
  // since Pull ignores columns it does not recognise.
  ownsColumn: (header: string) => boolean
}): Promise<PushGridResult> {
  const { spreadsheetId, tab, grid, keyStrategies, ownsColumn } = params

  // Read before writing. A failure here is not swallowed: it would silently turn
  // formula preservation off AND skip the stale-row clear below, leaving orphan
  // rows from deleted products in the tab. The read uses the same credentials as
  // the write that follows, so anything that breaks it breaks the Push anyway.
  const oldGrid = await readGridWithFormulas(spreadsheetId, tab)
  const preserved = planFormulaPreservation({ oldGrid, newGrid: grid, keyStrategies })

  await writeGrid(spreadsheetId, tab, grid)

  const newWidth = grid[0]?.length ?? 0
  const oldWidth = oldGrid.reduce((m, row) => Math.max(m, row.length), 0)
  const oldRows = oldGrid.length

  // Rows the old catalogue used that this one does not (products deleted since
  // the last Push). Cleared across the pushed columns only.
  if (oldRows > grid.length && newWidth > 0) {
    await clearRange(spreadsheetId, tab, `A${grid.length + 1}:${columnLetter(newWidth - 1)}${oldRows}`)
  }

  // Columns the old catalogue used that this one does not - cost_price switched
  // off, an option pair that no product needs any more. Grouped into contiguous
  // runs so this is one call in every realistic case.
  if (oldWidth > newWidth && oldRows > 0) {
    const oldHeader = (oldGrid[0] ?? []).map((c) => c.value.trim())
    const lastRow = Math.max(oldRows, grid.length)
    let runStart = -1
    for (let c = newWidth; c <= oldWidth; c++) {
      const mine = c < oldWidth && ownsColumn(oldHeader[c] ?? '')
      if (mine && runStart < 0) runStart = c
      if (!mine && runStart >= 0) {
        await clearRange(spreadsheetId, tab, `${columnLetter(runStart)}1:${columnLetter(c - 1)}${lastRow}`)
        runStart = -1
      }
    }
  }

  await writeFormulaRuns(spreadsheetId, tab, toFormulaRuns(preserved))

  return { rowCount: Math.max(grid.length - 1, 0), preservedFormulas: preserved.length }
}
