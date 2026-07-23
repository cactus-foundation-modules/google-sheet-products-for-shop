import { listSupplierCatalogues } from '@/modules/shop/lib/db'
import { type CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { TAB, ensureSupplierCataloguesTab } from '@/modules/google-sheet-products-for-shop/lib/workbook'

// The Supplier Catalogues tab.
//
// One-way, unlike Products and Variations: Push writes it, Pull never looks at
// it. It is a reference sheet - who you buy from, which catalogues they publish,
// and the link to each - so the person working in the spreadsheet has it beside
// the catalogue instead of in another browser tab. Editing it changes nothing;
// catalogues are added and edited under Shop, Suppliers.

export const SUPPLIER_CATALOGUE_COLUMNS = ['Supplier', 'Status', 'Catalogue', 'Google Sheet URL'] as const

const COLUMN_NAMES: ReadonlySet<string> = new Set(SUPPLIER_CATALOGUE_COLUMNS)

/**
 * Header row, then one row per catalogue, grouped under its supplier in the
 * supplier's own catalogue order.
 *
 * A supplier with no catalogues still gets a row, with the catalogue columns
 * blank. The tab is the supplier list as much as the catalogue list, and a
 * supplier silently missing from it would read as "not set up" rather than "none
 * recorded yet".
 */
export async function buildSupplierCataloguesGrid(): Promise<CellValue[][]> {
  const suppliers = await listSupplierCatalogues()
  const grid: CellValue[][] = [SUPPLIER_CATALOGUE_COLUMNS.map((c) => c as CellValue)]

  for (const supplier of suppliers) {
    const status = supplier.status === 'ENABLED' ? 'Enabled' : 'Disabled'
    if (supplier.catalogues.length === 0) {
      grid.push([supplier.name, status, '', ''])
      continue
    }
    for (const catalogue of supplier.catalogues) {
      grid.push([supplier.name, status, catalogue.name, catalogue.sheetUrl ?? ''])
    }
  }

  return grid
}

/**
 * DB -> Supplier Catalogues tab. Returns the number of rows written (excluding
 * the header), which is one per catalogue plus one per supplier with none.
 *
 * Goes through pushGrid like the other tabs, for the stale-row clear: when a
 * supplier or a catalogue is deleted the grid gets shorter, and the rows it has
 * given up have to be cleared or the tab keeps showing suppliers that are gone.
 * Formula preservation comes along with it and is harmless here - a formula in
 * the supplier's own column that still agrees with the database survives.
 */
export async function pushSupplierCataloguesTab(spreadsheetId: string): Promise<{ rowCount: number }> {
  // Workbooks created before this tab existed have to grow one first.
  await ensureSupplierCataloguesTab(spreadsheetId)

  const grid = await buildSupplierCataloguesGrid()
  const result = await pushGrid({
    spreadsheetId,
    tab: TAB.SUPPLIER_CATALOGUES,
    grid,
    // Supplier plus catalogue name identifies a row. A supplier with no
    // catalogues has a blank Catalogue cell, so it forms no key and keeps no
    // formulas - which is right: there is nothing on that row worth a formula.
    keyStrategies: [['Supplier', 'Catalogue']],
    ownsColumn: (header) => COLUMN_NAMES.has(header),
  })
  return { rowCount: result.rowCount }
}
