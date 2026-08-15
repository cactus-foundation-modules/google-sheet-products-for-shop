import { createSpreadsheet, writeGrid, batchUpdate, getSheetIds, getSheetGrids, getSheetList, addTab } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { desiredTabOrder, sameOrder, reorderRequests } from '@/modules/google-sheet-products-for-shop/lib/tab-order'
import { targetRows, targetColumns, CREATED_TAB_COLUMNS, type PlannedTab } from '@/modules/google-sheet-products-for-shop/lib/capacity'

// The fixed tabs, in order. Variations no longer has a single fixed tab: every
// variable product gets its OWN tab (created on Push, see ensureVariationTab),
// sitting between Products and Suppliers. Products MUST come before those product
// tabs because the Variations importer needs the parent products to already exist
// (it will not create parents) - the sync handlers enforce the same order.
//
// Suppliers is a one-way reference tab: Push writes it, Pull never reads it. It
// sits after the catalogue tabs and before the Read me.
export const TAB = {
  PRODUCTS: 'Products',
  SUPPLIERS: 'Suppliers',
  README: 'Read me',
} as const
export const TAB_ORDER: string[] = [TAB.PRODUCTS, TAB.SUPPLIERS, TAB.README]

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
    ['THE PRODUCT TABS'],
    ['- The Products tab lists every product. Each product that has variations also gets its own tab, named after it.'],
    ['- A product\'s tab shows only the options and columns that product actually uses, so you are never staring at blank columns meant for some other product.'],
    ['- A column with nothing in it for any of that product\'s variations is left off - a chair with no sale price gets no Sale Price column. The SKU, Variant ID and Price columns are always there.'],
    ['- To start using one that is not there, type its heading into the first empty column, fill in your values and Pull. The column is read by its heading, so that is all it takes - and the next Push keeps it, now that something is in it.'],
    ['- Do not rename or delete a product tab by hand. A Pull needs to find it; if it has gone, the Pull stops and asks you to Push again rather than risk removing those variants.'],
    ['- The tabs are kept in order for you: Products, Suppliers and this one first, then every product A to Z, then any tabs of your own. A Push puts them back in that order, so a new product lands in its right place rather than on the end.'],
    [''],
    ['THE SUPPLIERS TAB'],
    ['- A read-only list of your suppliers, their discount and the catalogues you have recorded against each one, refreshed on every Push.'],
    ['- Pull never reads it, so editing it changes nothing on your website. Add and edit suppliers and catalogues under Shop, Suppliers.'],
    [''],
    ['ORDER MATTERS'],
    ['- The Products tab is always synced before the product variation tabs, in both directions.'],
    ['- A variant\'s "Parent Slug" must already exist as a product, or its rows are skipped.'],
    [''],
    ['FORMULAS'],
    ['- You can use formulas in the catalogue columns. A Push keeps one as long as it still works out to the same value your website holds.'],
    ['- Once the value behind it changes, the Push replaces the formula with the new number. It has to: the number is the one that is true.'],
    ['- A Push keeps every row where it already sits in this sheet, with brand-new products added at the bottom - so your formulas stay put.'],
    ['- When a product goes, its whole row goes with it - so anything you keep in your own columns alongside moves up with the rest of the row and stays beside the right product.'],
    ['- A formula is still dropped if its row moves, which only happens when a product above it is removed. Nothing is lost but the formula.'],
    ['- A row left completely empty by an earlier version of this sheet - no product, no note of yours, nothing at all - is tidied away on the next Push. A row with anything of yours on it is never touched.'],
    ['- Columns you add to the RIGHT of the last one we fill in are yours entirely. A Push never writes there and never clears there, so formulas live on - and a new catalogue column is slotted in beside them, never on top.'],
    [''],
    ['MOVING THE COLUMNS ABOUT'],
    ['- Drag the columns into whatever order suits you. A Pull reads them by their heading, not by where they sit, and a Push puts them back exactly where you left them.'],
    ['- Rename a heading, though, and that column stops being read at all. Leave the heading row alone and move the whole column instead.'],
    ['- A column added by a later update arrives at the far right of ours, so nothing you have arranged shuffles along to make room.'],
    [''],
    ['THE SLUG COLUMN'],
    ['- "slug" is the last part of a product\'s web address. Change it and Pull, and the product moves to the new address.'],
    ['- Leave it alone if you are unsure: anyone linking to the old address will land on nothing.'],
    ['- A row with no SKU is matched to your site by its slug, so blanking that column on an existing product creates a duplicate.'],
    [''],
    ['THE DESCRIPTION_PUCK COLUMN'],
    ['- Products whose description you have laid out in the description designer carry that design here, as one long line of code.'],
    ['- It is here so a Push and a Pull carry it with everything else. It is not meant to be read, and hand-editing it is asking for trouble.'],
    ['- Copying the whole cell from one product to another is fine, and does exactly what you would expect.'],
    ['- Empty the cell and Pull, and that product goes back to using the plain description text.'],
    ['- If the cell says the design is too large, leave it be - that product\'s design is edited in the admin only, and a Pull will not touch it.'],
    ['- Mangle it and the Pull will tell you which row is wrong and leave that product\'s design exactly as it was.'],
    [''],
    ['THE VARIATIONS COLUMN'],
    ['- Shows how many variations each product has, which is the number of rows on that product\'s own tab. A product with none shows 0.'],
    ['- It is worked out for you and only ever read one way. Typing a different number here does nothing, and the next Push puts the real one back.'],
    ['- Add or remove variations on the product\'s own tab, or in the admin.'],
    [''],
    ['WHAT IS AND ISN\'T COVERED'],
    ['- Add-ons (extra text/number/checkbox fields on a product) are not in this sheet and are never changed by a sync.'],
    ['- A value that matches one on the option\'s master list (an attribute) picks up that list\'s colour or picture automatically. A truly new value, on an option with no master list, has no swatch until you add one in the admin.'],
    ['- Option types created via this sheet default to a dropdown; change the type in the admin if you need something else.'],
    [''],
    ['COLUMNS YOU CAN LEAVE OUT'],
    ['- Stock count and trade price can be kept out of this sheet entirely, under Settings, Shop, Google Sheet.'],
    ['- A column left out disappears on the next Push and stops syncing both ways - a Pull leaves that figure alone on your website.'],
    ['- Switch one back on and the column returns on the next Push, filled in from your website.'],
    [''],
    ['A NOTE ON COST PRICE'],
    ['- The cost_price column holds your supplier cost (your margin), and each product\'s variation tab carries the same figure per variant.'],
    ['- It is always included, so anyone you share this sheet with can see it. Share the sheet with that in mind.'],
    [''],
    ['IF THE SHEET SAYS IT HAS RUN OUT OF ROOM'],
    ['- Google limits how big one spreadsheet can get, counting every cell in every tab whether there is anything in it or not.'],
    ['- Each product tab is made only as big as that product needs, and trimmed back down as it shrinks, so a Push claims as little of that room as it can.'],
    ['- Tabs of your own count too. Delete any you have finished with, or create a fresh sheet from the settings page, and push again.'],
    [''],
    ['IF IT STOPS WORKING AFTER ABOUT A WEEK'],
    ['- Your Google consent screen is probably still in "Testing" mode, which expires access after 7 days.'],
    ['- Publish it to "In production" (one button, no review needed) and reconnect on the settings tab.'],
  ]
}

// How far across the starting column widths are applied. Wide enough to cover
// the Products tab's own columns; clamped to the tab's actual width by every
// caller, because a dimension request that runs past the last column GROWS the
// tab to reach it - which is how every product tab ended up 45 columns wide
// holding twenty, and how a workbook of a few hundred tabs reached Google's
// ten-million-cell ceiling (see lib/capacity.ts).
const WIDTH_COLUMNS = 45

// Freeze, bold and protect the header row of one tab, and give its columns a
// sensible starting width. Sheet/cell properties, so they outlive every value
// rewrite a Push does - Push never needs to re-format. `columnCount` is the tab's
// own width, which the width request is never allowed to exceed.
function headerFormattingRequests(sheetId: number, protectionNote: string, columnCount: number): unknown[] {
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
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: Math.min(WIDTH_COLUMNS, Math.max(1, columnCount)) },
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
  for (const tab of [TAB.PRODUCTS, TAB.SUPPLIERS]) {
    const sheetId = created.sheetIds[tab]
    if (sheetId === undefined) continue
    const note = tab === TAB.SUPPLIERS ? REFERENCE_HEADER_NOTE : SYNCED_HEADER_NOTE
    // A tab created by spreadsheets.create gets Google's default 26 columns; the
    // Push widens it to whatever the catalogue needs on the way in.
    requests.push(...headerFormattingRequests(sheetId, note, CREATED_TAB_COLUMNS))
  }
  await batchUpdate(created.spreadsheetId, requests)

  return { spreadsheetId: created.spreadsheetId, spreadsheetUrl: created.spreadsheetUrl }
}

// Make sure a product's variation tab exists and is formatted, returning true
// when it had to be created (so the caller knows a fresh header needs writing).
// The tab title is a product's, computed by the caller (see variation-tabs.ts).
// Idempotent: an existing tab is left exactly as it is, formatting and all.
export async function ensureVariationTab(spreadsheetId: string, title: string): Promise<boolean> {
  // Slot new product tabs right after Products; Google clamps an out-of-range
  // index to the end, and existing tabs shift right harmlessly.
  const sheetId = await addTab(spreadsheetId, title, 1)
  if (sheetId === null) return false // already there
  await batchUpdate(spreadsheetId, headerFormattingRequests(sheetId, SYNCED_HEADER_NOTE, CREATED_TAB_COLUMNS))
  return true
}

// Create MANY variation tabs in one batchUpdate, formatting included - one write
// where the one-at-a-time path spent two writes and a read per tab. The caller
// has already checked which titles are missing (against its own getSheetIds
// read), so this never re-checks. addSheet is given an EXPLICIT sheetId, chosen
// clear of every id in `existingIds`, which is what lets the formatting requests
// in the same call reference the new sheet before Google has named one.
// batchUpdate is atomic, so a failure creates nothing rather than half the tabs.
// Returns the id assigned to each title.
//
// Each tab is created at the SIZE IT NEEDS, plus a little slack (see
// lib/capacity.ts). An addSheet with no gridProperties gets Google's default 1000
// rows, so a product with forty variants used to be handed a grid twenty-five
// times bigger than its contents - and Google counts every blank cell of it
// against the workbook's ten-million-cell ceiling. A few hundred product tabs is
// enough to reach that ceiling, at which point the Push stops mid-batch with
// "This action would increase the number of cells in the workbook above the
// limit". The tab still grows on demand: a Push that writes past the last row
// widens the grid itself.
export async function createVariationTabsBatch(
  spreadsheetId: string,
  tabs: PlannedTab[],
  existingIds: Iterable<number>,
): Promise<Record<string, number>> {
  const assigned: Record<string, number> = {}
  if (tabs.length === 0) return assigned
  const taken = new Set<number>(existingIds)
  // Sequential from just past the largest known id - well inside int32, and
  // collision-free against everything the caller can see.
  let next = Math.max(0, ...taken) + 1
  const requests: unknown[] = []
  for (const tab of tabs) {
    while (taken.has(next)) next++
    const sheetId = next
    taken.add(sheetId)
    assigned[tab.title] = sheetId
    const rowCount = targetRows(tab.rows)
    const columnCount = targetColumns(tab.columns)
    // No index: a new tab is appended, and the CLEANUP phase puts every tab in
    // its place afterwards (see orderTabs). Slotting each new one at index 1, as
    // this used to, left a freshly built workbook in reverse order of creation
    // with Suppliers and Read me shunted to the far end.
    requests.push({ addSheet: { properties: { sheetId, title: tab.title, gridProperties: { rowCount, columnCount } } } })
    requests.push(...headerFormattingRequests(sheetId, SYNCED_HEADER_NOTE, columnCount))
  }
  await batchUpdate(spreadsheetId, requests)
  return assigned
}

/**
 * Put the tabs in order: Products, Suppliers, Read me, then every product tab
 * A-Z, then anything the owner has added themselves.
 *
 * Run at the end of a Push, once the orphan sweep has been and gone, so nothing
 * about to be deleted is carefully filed first. A workbook already in order
 * costs one read and no write at all, which is every Push after the first.
 *
 * The owner's own tabs end up after the product tabs rather than wherever they
 * were - unavoidable, since the product tabs have to be contiguous from position
 * three - but they keep their order relative to each other.
 */
export async function orderTabs(spreadsheetId: string, variationTitles: ReadonlySet<string>): Promise<void> {
  const list = await getSheetList(spreadsheetId)
  const current = list.map((s) => s.title)
  const desired = desiredTabOrder(current, variationTitles, TAB_ORDER)
  if (sameOrder(current, desired)) return
  await batchUpdate(spreadsheetId, reorderRequests(desired, new Map(list.map((s) => [s.title, s.sheetId]))))
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
  await batchUpdate(spreadsheetId, headerFormattingRequests(sheetId, REFERENCE_HEADER_NOTE, CREATED_TAB_COLUMNS))
}

// The in-sheet dropdowns that stop the typo class the import would reject anyway,
// at the point of typing rather than the point of pulling. Applied on Push,
// because the column positions are only known once the grid has been laid out
// against the sheet the owner actually has - they move with a column the owner
// has dragged somewhere else.
const VALIDATION_LISTS: Record<string, string[]> = {
  type: ['PHYSICAL', 'DIGITAL', 'SERVICE'],
  status: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
  out_of_stock_behaviour: ['BLOCK', 'BACKORDER'],
  related_mode: ['MANUAL', 'AUTOMATIC'],
  upsell_mode: ['MANUAL', 'AUTOMATIC'],
}

/**
 * The dropdown requests for one Products tab, given the header ACTUALLY written
 * (which is the sheet's own column order - see orderColumnsLikeSheet - not the
 * canonical export order).
 *
 * The block is cleared before it is re-applied. A dropdown is a property of the
 * cells, not of the column label, so a column the owner has dragged elsewhere
 * would otherwise leave its rule sitting on whatever now occupies the old
 * position - a "status" list refusing every value the column there accepts. The
 * clear covers the pushed columns only; the owner's own columns to the right,
 * and any validation they have put on them, are never touched.
 */
// How far down the dropdowns reach when the caller does not say. A range that
// runs past the last row GROWS the tab to reach it, so a caller that knows the
// tab's height passes it and the rules stop there.
export const VALIDATION_ROWS = 5000

export function productsValidationRequests(sheetId: number, columns: string[], rows: number = VALIDATION_ROWS): unknown[] {
  if (columns.length === 0) return []
  const endRowIndex = Math.max(2, rows)
  const requests: unknown[] = [
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex, startColumnIndex: 0, endColumnIndex: columns.length },
      },
    },
  ]
  for (const [column, values] of Object.entries(VALIDATION_LISTS)) {
    const colIndex = columns.indexOf(column)
    if (colIndex < 0) continue
    requests.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true,
          strict: true,
        },
      },
    })
  }
  return requests
}

// The dropdowns stop at the Products tab's own last row rather than a fixed
// 5,000: a validation range past the end of the grid makes Google grow the tab to
// meet it, which on a small catalogue is thousands of blank cells charged against
// the workbook's ceiling, and on a big one undoes the trim the Push just did.
export async function applyProductsValidation(spreadsheetId: string, columns: string[]): Promise<void> {
  const grids = await getSheetGrids(spreadsheetId)
  const grid = grids[TAB.PRODUCTS]
  if (grid === undefined) return
  await batchUpdate(spreadsheetId, productsValidationRequests(grid.sheetId, columns, grid.rowCount))
}
