import { createSpreadsheet, writeGrid, batchUpdate, getSheetIds } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// The three tabs, in order. Products MUST come before Variations because the
// Variations importer needs the parent products to already exist (it will not
// create parents) - the sync handlers enforce the same order in code.
export const TAB = { PRODUCTS: 'Products', VARIATIONS: 'Variations', README: 'Read me' } as const
export const TAB_ORDER: string[] = [TAB.PRODUCTS, TAB.VARIATIONS, TAB.README]

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
    ['ORDER MATTERS'],
    ['- The Products tab is always synced before the Variations tab, in both directions.'],
    ['- A variant\'s "Parent Slug" must already exist as a product, or its rows are skipped.'],
    [''],
    ['WHAT IS AND ISN\'T COVERED'],
    ['- Add-ons (extra text/number/checkbox fields on a product) are not in this sheet and are never changed by a sync.'],
    ['- Colour/image swatches on brand-new option values created via this sheet are not carried across - add those in the admin.'],
    ['- Option types created via this sheet default to a dropdown; change the type in the admin if you need something else.'],
    [''],
    ['A NOTE ON COST PRICE'],
    ['- If the cost_price column is present, it holds your supplier cost (your margin). Anyone you share this sheet with can see it.'],
    ['- You can hide it: turn off "Include cost price" on the settings tab and Push again, and the column disappears.'],
    [''],
    ['IF IT STOPS WORKING AFTER ABOUT A WEEK'],
    ['- Your Google consent screen is probably still in "Testing" mode, which expires access after 7 days.'],
    ['- Publish it to "In production" (one button, no review needed) and reconnect on the settings tab.'],
  ]
}

// Create the workbook, write the Read me tab, and apply all formatting ONCE.
// The header formatting (freeze, bold, protection) is a sheet/cell property, so
// it outlives the value rewrites a Push does - Push never needs to re-format.
export async function createWorkbook(title: string): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const created = await createSpreadsheet(title, TAB_ORDER)
  await writeGrid(created.spreadsheetId, TAB.README, readmeRows())

  const requests: unknown[] = []
  for (const tab of [TAB.PRODUCTS, TAB.VARIATIONS]) {
    const sheetId = created.sheetIds[tab]
    if (sheetId === undefined) continue
    // Freeze the header row.
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    })
    // Bold the header row.
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    })
    // Protect the header row - warning only, so the owner can still unprotect it
    // if they genuinely need to, but is nudged before mangling it by accident.
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          warningOnly: true,
          description: 'Header row - Pull relies on these column names. Edit with care.',
        },
      },
    })
    // Sensible starting column widths across the used range (harmless on unused).
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 30 },
        properties: { pixelSize: 160 },
        fields: 'pixelSize',
      },
    })
  }
  await batchUpdate(created.spreadsheetId, requests)

  return { spreadsheetId: created.spreadsheetId, spreadsheetUrl: created.spreadsheetUrl }
}

// The in-sheet dropdowns that stop the typo class the import would reject anyway,
// at the point of typing rather than the point of pulling. Applied on Push,
// because the exact column positions depend on whether cost_price is present -
// which Push knows and creation does not.
const VALIDATION_LISTS: Record<string, string[]> = {
  type: ['PHYSICAL', 'DIGITAL', 'SERVICE'],
  status: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
  out_of_stock_behaviour: ['BLOCK', 'BACKORDER'],
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
