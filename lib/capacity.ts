// How big a Google workbook is allowed to get, and how big this module lets its
// own tabs be.
//
// Google caps ONE spreadsheet at ten million cells, counting every cell in every
// tab whether anything is in it or not. A tab created without gridProperties gets
// Google's default 1000 rows, and the header formatting this module applies runs
// out to column 45 - so every product tab cost tens of thousands of cells to hold
// a few dozen variants. A catalogue with a few hundred variable products reached
// the ceiling with the sheet barely a twentieth full, and the Push died mid-batch
// with Google's own wording:
//
//   Invalid requests[45].addSheet: This action would increase the number of cells
//   in the workbook above the limit of 10000000 cells.
//
// Three things keep it away from the ceiling now, and all three live here:
//   - New tabs are CREATED at the size they need (see createVariationTabsBatch).
//   - A tab that is pushed is SHRUNK to what it actually uses (see pushGrids),
//     which is the only place that knows the real used extent - the owner's own
//     columns included, so their work is never trimmed away.
//   - Before any tab is created, the Push checks the whole workbook against the
//     budget below, reclaims the blank rows on tabs it owns if it is short, and
//     stops with a plain sentence rather than Google's if it still does not fit.

export const WORKBOOK_CELL_LIMIT = 10_000_000

// Stop short of Google's ceiling. The gap absorbs the owner's own columns, the
// Suppliers and Read me tabs, and anything else in the workbook this module does
// not own and must never resize.
export const CELL_BUDGET = 9_000_000

// Room left on a tab beyond what the catalogue fills, so the owner can type a
// few rows or add a column of their own without a Push having to grow the grid
// first. Small enough that a few hundred tabs still cost a fraction of the
// budget: a 60-variant product tab lands at 110 rows by 26 columns.
export const ROW_SLACK = 50
export const MIN_ROWS = 100
export const COLUMN_SLACK = 5
export const MIN_COLUMNS = 26

// One tab's grid dimensions, as spreadsheets.get reports them.
export type SheetGrid = { sheetId: number; rowCount: number; columnCount: number }

// The size a tab holding `needed` rows/columns of content should be given.
export function targetRows(needed: number): number {
  return Math.max(needed + ROW_SLACK, MIN_ROWS)
}
export function targetColumns(needed: number): number {
  return Math.max(needed + COLUMN_SLACK, MIN_COLUMNS)
}

export function cellsIn(grid: { rowCount: number; columnCount: number }): number {
  return Math.max(0, grid.rowCount) * Math.max(0, grid.columnCount)
}

// Every cell in the workbook, blank ones included - which is what Google counts.
export function totalCells(grids: Record<string, SheetGrid>): number {
  return Object.values(grids).reduce((sum, g) => sum + cellsIn(g), 0)
}

// The reclaim pass is deliberately more generous than targetRows: it runs on tabs
// that are ALREADY in the sheet, without having read them, so it only knows how
// many rows the catalogue is about to put there and not what else may be sitting
// below. Two hundred spare rows per tab is enough slack to be safe and still
// takes a default 1000-row tab down by three quarters. Columns are never touched
// here for the same reason - the owner's own columns sit to the right of ours and
// nothing in this pass can see where they end. The precise trim on push does both
// dimensions, because by then the tab has been read.
export const RECLAIM_ROW_SLACK = 200
export const RECLAIM_MIN_ROWS = 250

export function reclaimRowTarget(needed: number): number {
  return Math.max(needed + RECLAIM_ROW_SLACK, RECLAIM_MIN_ROWS)
}

// A tab this module is about to create, and how much it needs to hold.
export type PlannedTab = { title: string; rows: number; columns: number }

// A tab already in the sheet that this module owns, and how many rows of
// catalogue are about to be written to it.
export type ExistingTab = { title: string; rows: number }

export type CapacityPlan = {
  // updateSheetProperties requests that shrink over-sized tabs. Empty when the
  // workbook already fits, so the ordinary Push spends nothing on this.
  requests: unknown[]
  // Cells the workbook holds now, and what it would hold once the reclaim above
  // has been applied and every planned tab created.
  currentCells: number
  projectedCells: number
  // True when it still does not fit, even after the reclaim.
  overBudget: boolean
}

/**
 * Work out whether the tabs a Push is about to create will fit, and what to
 * shrink if they will not.
 *
 * Nothing is reclaimed when the workbook already has room: a Push on a healthy
 * sheet emits no requests at all and the tabs it creates are the right size to
 * begin with. The reclaim only earns its keep on a workbook that grew under an
 * older version of this module, where a few hundred tabs are sitting at Google's
 * default 1000 rows to hold a few dozen variants each.
 */
export function planCapacity(params: {
  grids: Record<string, SheetGrid>
  existing: ExistingTab[]
  planned: PlannedTab[]
}): CapacityPlan {
  const { grids, existing, planned } = params
  const currentCells = totalCells(grids)
  const newCells = planned.reduce((sum, t) => sum + targetRows(t.rows) * targetColumns(t.columns), 0)

  if (currentCells + newCells <= CELL_BUDGET) {
    return { requests: [], currentCells, projectedCells: currentCells + newCells, overBudget: false }
  }

  const requests: unknown[] = []
  let freed = 0
  for (const tab of existing) {
    const grid = grids[tab.title]
    if (!grid) continue
    const rowCount = reclaimRowTarget(tab.rows)
    if (rowCount >= grid.rowCount) continue // already at or below what it needs
    freed += (grid.rowCount - rowCount) * Math.max(0, grid.columnCount)
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: grid.sheetId, gridProperties: { rowCount } },
        fields: 'gridProperties.rowCount',
      },
    })
  }

  const projectedCells = currentCells - freed + newCells
  return { requests, currentCells, projectedCells, overBudget: projectedCells > CELL_BUDGET }
}

// What the owner is told when the workbook genuinely cannot hold the catalogue.
// No cell counts, no mention of Google's limit as a number they can act on - just
// what is full, and the two things that actually make room.
export function workbookFullMessage(): string {
  return 'This spreadsheet has run out of room - Google limits how big one spreadsheet can get, and your catalogue no longer fits alongside everything else in it. Delete any tabs of your own you no longer need, or create a fresh sheet from the settings page, then push again.'
}
