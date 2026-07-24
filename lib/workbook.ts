import { createSpreadsheet, writeGrid, batchUpdate, getSheetIds, addTab } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// The four tabs, in order. Products MUST come before Variations because the
// Variations importer needs the parent products to already exist (it will not
// create parents) - the sync handlers enforce the same order in code.
//
// Suppliers is a one-way reference tab: Push writes it, Pull never reads it. It
// sits after the two catalogue tabs and before the Read me.
export const TAB = {
  PRODUCTS: 'Products',
  VARIATIONS: 'Variations',
  SUPPLIERS: 'Suppliers',
  README: 'Read me',
} as const
export const TAB_ORDER: string[] = [TAB.PRODUCTS, TAB.VARIATIONS, TAB.SUPPLIERS, TAB.README]

// The Suppliers tab was first shipped as "Supplier Catalogues". Workbooks created
// under the old name are renamed in place on the next Push (see ensureSuppliersTab)
// so their data, formatting and any owner formulas carry across rather than being
// stranded on a tab beside a fresh, blank one.
const LEGACY_SUPPLIERS_TAB_TITLE = 'Supplier Catalogues'

// Static guidance. Never parsed - the parser only ever touches Products and
// Variations. Written as one cell per line down column A.
function readmeRows(): string[][] {
  return [
    ['Shop catalogue mirror'],
    [''],
    ['This spreadsheet is a working copy of your shop catalogue, synced by hand from the Cactus admin.'],
    ['It is not live and it is not the source of truth - your website is.'],
    [''],
    ['HOW IT WORKS'],
    ['- "Push to sheet" in the admin overwrites this sheet with what is on your website.'],
    ['- "Pull from sheet" in the admin overwrites your website with this sheet, after showing you a preview first.'],
    ['- Editing cells here does NOTHING until you press Pull. Nothing here reaches your site on its own.'],
    [''],
    ['THE SUPPLIERS TAB'],
    ['- A read-only list of your suppliers, their discount and the catalogues you have recorded against each one, refreshed on every Push.'],
    ['- Pull never reads it, so editing it changes nothing on your website. Add and edit suppliers and catalogues under Shop, Suppliers.'],
    [''],
    ['ORDER MATTERS'],
    ['- The Products tab is always synced before the Variations tab, in both directions.'],
    ['- A variant\'s "Parent Slug" must already exist as a product, or its rows are skipped.'],
    [''],
    ['FORMULAS'],
    ['- You can use formulas in the catalogue columns. A Push keeps one as long as it still works out to the same value your website holds.'],
    ['- Once the value behind it changes, the Push replaces the formula with the new number. It has to: the number is the one that is true.'],
    ['- A Push keeps every row where it already sits in this sheet, with brand-new products added at the bottom - so your formulas stay put.'],
    ['- A formula is still dropped if its row moves, which now only happens when a product above it is removed. Nothing is lost but the formula.'],
    ['- Columns you add to the RIGHT of the last one we fill in are yours entirely. A Push never writes there and never clears there, so formulas live on.'],
    [''],
    ['THE SLUG COLUMN'],
    ['- "slug" is the last part of a product\'s web address. Change it and Pull, and the product moves to the new address.'],
    ['- Leave it alone if you are unsure: anyone linking to the old address will land on nothing.'],
    ['- A row with no SKU is matched to your site by its slug, so blanking that column on an existing product creates a duplicate.'],
    [''],
    ['WHAT IS AND ISN\'T COVERED'],
    ['- Add-ons (extra text/number/checkbox fields on a product) are not in this sheet and are never changed by a sync.'],
    ['- Colour/image swatches on brand-new option values created via this sheet are not carried across - add those in the admin.'],
    ['- Option types created via this sheet default to a dropdown; change the type in the admin if you need something else.'],
    [''],
    ['A NOTE ON COST PRICE'],
    ['- The cost_price column holds your supplier cost (your margin), and the Variations tab carries the same figure per variant.'],
    ['- It is always included, so anyone you share this sheet with can see it. Share the sheet with that in mind.'],
    [''],
    ['IF IT STOPS WORKING AFTER ABOUT A WEEK'],
    ['- Your Google consent screen is probably still in "Testing" mode, which expires access after 7 days.'],
    ['- Publish it to "In production" (one button, no review needed) and reconnect on the settings tab.'],
  ]
}

// Freeze, bold and protect the header row of one tab, and give its columns a
// sensible starting width. Sheet/cell properties, so they outlive every value
// rewrite a Push does - Push never needs to re-format.
function headerFormattingRequests(sheetId: number, protectionNote: string): unknown[] {
  return [
    // Freeze the header row.
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Bold the header row.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    // Protect the header row - warning only, so the owner can still unprotect it
    // if they genuinely need to, but is nudged before mangling it by accident.
    {
      addProtectedRange: {
        protectedRange: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          warningOnly: true,
          description: protectionNote,
        },
      },
    },
    // Sensible starting column widths across the used range (harmless on unused).
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 45 },
        properties: { pixelSize: 160 },
        fields: 'pixelSize',
      },
    },
  ]
}

const SYNCED_HEADER_NOTE = 'Header row - Pull relies on these column names. Edit with care.'
const REFERENCE_HEADER_NOTE = 'Header row - this tab is rewritten on every Push and never read back.'

// Create the workbook, write the Read me tab, and apply all formatting ONCE.
// The header formatting (freeze, bold, protection) is a sheet/cell property, so
// it outlives the value rewrites a Push does - Push never needs to re-format.
export async function createWorkbook(title: string): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const created = await createSpreadsheet(title, TAB_ORDER)
  await writeGrid(created.spreadsheetId, TAB.README, readmeRows())

  const requests: unknown[] = []
  for (const tab of [TAB.PRODUCTS, TAB.VARIATIONS, TAB.SUPPLIERS]) {
    const sheetId = created.sheetIds[tab]
    if (sheetId === undefined) continue
    const note = tab === TAB.SUPPLIERS ? REFERENCE_HEADER_NOTE : SYNCED_HEADER_NOTE
    requests.push(...headerFormattingRequests(sheetId, note))
  }
  await batchUpdate(created.spreadsheetId, requests)

  return { spreadsheetId: created.spreadsheetId, spreadsheetUrl: created.spreadsheetUrl }
}

/**
 * Make sure the Suppliers tab exists, formatting it on the way in.
 *
 * Three cases, in order:
 *   - The tab is already there under its current name: nothing to do (every Push
 *     after the first).
 *   - It is there under its old name, "Supplier Catalogues": rename it in place so
 *     the data, header formatting and any owner formulas move with it. A Push that
 *     simply wrote to the new title would instead leave the old tab stranded and
 *     start a blank one.
 *   - It was never there (workbook predates the tab): add and format it. The tab
 *     arrives on the owner's next Push with no action from them.
 */
export async function ensureSuppliersTab(spreadsheetId: string): Promise<void> {
  const sheetIds = await getSheetIds(spreadsheetId)
  if (sheetIds[TAB.SUPPLIERS] !== undefined) return

  const legacyId = sheetIds[LEGACY_SUPPLIERS_TAB_TITLE]
  if (legacyId !== undefined) {
    await batchUpdate(spreadsheetId, [
      { updateSheetProperties: { properties: { sheetId: legacyId, title: TAB.SUPPLIERS }, fields: 'title' } },
    ])
    return
  }

  // Index 2 puts it after Products and Variations on workbooks that have the
  // original three tabs; Google clamps an out-of-range index to the end.
  const sheetId = await addTab(spreadsheetId, TAB.SUPPLIERS, 2)
  if (sheetId === null) return
  await batchUpdate(spreadsheetId, headerFormattingRequests(sheetId, REFERENCE_HEADER_NOTE))
}

// The in-sheet dropdowns that stop the typo class the import would reject anyway,
// at the point of typing rather than the point of pulling. Applied on Push,
// because the exact column positions depend on whether cost_price is present -
// which Push knows and creation does not.
const VALIDATION_LISTS: Record<string, string[]> = {
  type: ['PHYSICAL', 'DIGITAL', 'SERVICE'],
  status: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
  out_of_stock_behaviour: ['BLOCK', 'BACKORDER'],
  related_mode: ['MANUAL', 'AUTOMATIC'],
  upsell_mode: ['MANUAL', 'AUTOMATIC'],
}

export async function applyProductsValidation(spreadsheetId: string, columns: string[]): Promise<void> {
  const sheetIds = await getSheetIds(spreadsheetId)
  const sheetId = sheetIds[TAB.PRODUCTS]
  if (sheetId === undefined) return

  const requests: unknown[] = []
  for (const [column, values] of Object.entries(VALIDATION_LISTS)) {
    const colIndex = columns.indexOf(column)
    if (colIndex < 0) continue
    requests.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true,
          strict: true,
        },
      },
    })
  }
  await batchUpdate(spreadsheetId, requests)
}
