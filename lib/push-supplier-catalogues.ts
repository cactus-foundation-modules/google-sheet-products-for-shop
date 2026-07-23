import { listSupplierCatalogues } from '@/modules/shop/lib/db'
import { type CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { TAB, ensureSuppliersTab } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// The Suppliers tab.
//
// One-way, unlike Products and Variations: Push writes it, Pull never looks at
// it. It is a reference sheet - who you buy from, the discount you have on file
// for each, which catalogues they publish and the link to each - so the person
// working in the spreadsheet has it beside the catalogue instead of in another
// browser tab. Editing it changes nothing; suppliers and catalogues are added and
// edited under Shop, Suppliers.

// Discount is the supplier's own figure, so it repeats down that supplier's rows
// the way Status does. It is written as a bare number (no "%") so the cell can be
// summed or compared in the sheet.
export const SUPPLIERS_COLUMNS = ['Supplier', 'Status', 'Discount', 'Catalogue', 'Google Sheet URL'] as const

const COLUMN_NAMES: ReadonlySet<string> = new Set(SUPPLIERS_COLUMNS)

/**
 * Header row, then one row per catalogue, grouped under its supplier in the
 * supplier's own catalogue order.
 *
 * A supplier with no catalogues still gets a row, with the catalogue columns
 * blank. The tab is the supplier list as much as the catalogue list, and a
 * supplier silently missing from it would read as "not set up" rather than "none
 * recorded yet".
 */
export async function buildSuppliersGrid(): Promise<CellValue[][]> {
  const suppliers = await listSupplierCatalogues()
  const grid: CellValue[][] = [SUPPLIERS_COLUMNS.map((c) => c as CellValue)]

  for (const supplier of suppliers) {
    const status = supplier.status === 'ENABLED' ? 'Enabled' : 'Disabled'
    // Blank when none is on file, rather than a misleading 0.
    const discount: CellValue = supplier.discountPercent ?? ''
    if (supplier.catalogues.length === 0) {
      grid.push([supplier.name, status, discount, '', ''])
      continue
    }
    for (const catalogue of supplier.catalogues) {
      grid.push([supplier.name, status, discount, catalogue.name, catalogue.sheetUrl ?? ''])
    }
  }

  return grid
}

/**
 * DB -> Suppliers tab. Returns the number of rows written (excluding
 * the header), which is one per catalogue plus one per supplier with none.
 *
 * Goes through pushGrid like the other tabs, for the stale-row clear: when a
 * supplier or a catalogue is deleted the grid gets shorter, and the rows it has
 * given up have to be cleared or the tab keeps showing suppliers that are gone.
 * Formula preservation comes along with it and is harmless here - a formula in
 * the supplier's own column that still agrees with the database survives.
 */
export async function pushSuppliersTab(spreadsheetId: string): Promise<{ rowCount: number }> {
  // Workbooks created before this tab existed have to grow one first; those
  // created under the tab's old name are renamed in place - see ensureSuppliersTab.
  await ensureSuppliersTab(spreadsheetId)

  const grid = await buildSuppliersGrid()
  const result = await pushGrid({
    spreadsheetId,
    tab: TAB.SUPPLIERS,
    grid,
    // Supplier plus catalogue name identifies a row. A supplier with no
    // catalogues has a blank Catalogue cell, so it forms no key and keeps no
    // formulas - which is right: there is nothing on that row worth a formula.
    keyStrategies: [['Supplier', 'Catalogue']],
    ownsColumn: (header) => COLUMN_NAMES.has(header),
  })
  return { rowCount: result.rowCount }
}
