import { getAccessToken, GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Thin fetch wrapper over the five Sheets/Drive REST calls this module needs.
// Deliberately no `googleapis` dependency: that package is enormous with a large
// transitive tree, new dependencies need sign-off, and five REST calls do not
// justify either.

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

// A1 range for a whole tab, or a tab anchored at a cell. Tab titles are quoted
// so a title with a space ("Read me") is still a valid range.
function tabRange(tab: string, a1?: string): string {
  return encodeURIComponent(a1 ? `'${tab}'!${a1}` : `'${tab}'`)
}

// One access-token-bearing request, with a single refresh-and-retry on a 401
// (never a loop). getAccessToken(true) forces a refresh and persists the new
// token, so the retry reads a fresh one.
async function googleFetch(url: string, init: RequestInit, allowRetry = true): Promise<Response> {
  const token = await getAccessToken()
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 401 && allowRetry) {
    await getAccessToken(true)
    return googleFetch(url, init, false)
  }
  return res
}

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  if (res.status === 401 || res.status === 403) {
    throw new GoogleAuthError(`Google refused the ${what} request (${res.status}). Reconnect the account on the settings page.`)
  }
  const text = await res.text().catch(() => '')
  throw new Error(`Google Sheets ${what} failed: ${res.status} ${text.slice(0, 500)}`)
}

export type CreatedSpreadsheet = {
  spreadsheetId: string
  spreadsheetUrl: string
  sheetIds: Record<string, number>
}

// spreadsheets.create with the given tab titles, in order.
export async function createSpreadsheet(title: string, tabTitles: string[]): Promise<CreatedSpreadsheet> {
  const res = await ok(
    await googleFetch(SHEETS_API, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title },
        sheets: tabTitles.map((t, i) => ({ properties: { title: t, index: i } })),
      }),
    }),
    'create spreadsheet'
  )
  const data = (await res.json()) as {
    spreadsheetId: string
    spreadsheetUrl: string
    sheets: Array<{ properties: { sheetId: number; title: string } }>
  }
  const sheetIds: Record<string, number> = {}
  for (const s of data.sheets) sheetIds[s.properties.title] = s.properties.sheetId
  return { spreadsheetId: data.spreadsheetId, spreadsheetUrl: data.spreadsheetUrl, sheetIds }
}

// What a single cell may hold on the way in. Numbers and booleans are sent as
// JSON numbers/booleans so Sheets stores them as numbers and booleans: a numeric
// string under valueInputOption=RAW lands as text, which Sheets displays as
// '100 and will not sum, sort or chart.
export type CellValue = string | number | boolean

// values.update, RAW - no cell is ever evaluated as a formula.
export async function writeGrid(spreadsheetId: string, tab: string, values: CellValue[][]): Promise<void> {
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values/${tabRange(tab, 'A1')}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),
    'write grid'
  )
}

// values.get, UNFORMATTED_VALUE - numbers/booleans arrive as strings via the
// coercion below so the import engines see a plain grid of text, as from a CSV.
export async function readGrid(spreadsheetId: string, tab: string): Promise<string[][]> {
  const res = await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values/${tabRange(tab)}?valueRenderOption=UNFORMATTED_VALUE`, {
      method: 'GET',
    }),
    'read grid'
  )
  const data = (await res.json()) as { values?: unknown[][] }
  return (data.values ?? []).map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
}

// One cell as it currently stands in the sheet: the formula the owner typed (or
// null for a plain value), and what that formula evaluated to. Both are needed to
// decide whether a formula may survive a Push - see lib/formula-preserve.ts.
export type SheetCell = {
  // The literal formula text, e.g. "=B2*1.2". Null for an ordinary value cell.
  formula: string | null
  // The computed result, stringified the same way readGrid stringifies values so
  // the two can be compared against one grid of new values.
  value: string
  // True when the formula currently evaluates to an error (#REF!, #DIV/0! etc).
  // Such a cell has no trustworthy result, so it is never preserved.
  error: boolean
}

type ExtendedValue = {
  numberValue?: number
  stringValue?: string
  boolValue?: boolean
  formulaValue?: string
  errorValue?: { type?: string; message?: string }
}

function stringifyExtended(v: ExtendedValue | undefined): string {
  if (!v) return ''
  if (v.numberValue !== undefined) return String(v.numberValue)
  if (v.stringValue !== undefined) return v.stringValue
  if (v.boolValue !== undefined) return String(v.boolValue)
  return ''
}

// spreadsheets.get with grid data - the one call that returns both what the owner
// typed (userEnteredValue, which carries formulaValue) and what it came out as
// (effectiveValue). The `fields` mask keeps the payload to those two per cell;
// without it Google ships every format, border and note in the tab.
export async function readGridWithFormulas(spreadsheetId: string, tab: string): Promise<SheetCell[][]> {
  const fields = encodeURIComponent('sheets.data.rowData.values(userEnteredValue,effectiveValue)')
  const res = await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}?ranges=${tabRange(tab)}&includeGridData=true&fields=${fields}`, {
      method: 'GET',
    }),
    'read grid with formulas'
  )
  const data = (await res.json()) as {
    sheets?: Array<{ data?: Array<{ rowData?: Array<{ values?: Array<{ userEnteredValue?: ExtendedValue; effectiveValue?: ExtendedValue }> }> }> }>
  }
  const rowData = data.sheets?.[0]?.data?.[0]?.rowData ?? []
  return rowData.map((row) =>
    (row.values ?? []).map((cell) => ({
      formula: cell.userEnteredValue?.formulaValue ?? null,
      value: stringifyExtended(cell.effectiveValue),
      error: cell.effectiveValue?.errorValue !== undefined,
    }))
  )
}

// 0-based column index -> A1 column letters (0 -> A, 26 -> AA).
export function columnLetter(index: number): string {
  let n = index
  let out = ''
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  }
  return out
}

// values.clear over one A1 range, e.g. "A51:AS400". Used instead of clearing the
// whole tab so columns the owner has added beyond the catalogue survive a Push.
export async function clearRange(spreadsheetId: string, tab: string, a1: string): Promise<void> {
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values/${tabRange(tab, a1)}:clear`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    'clear range'
  )
}

// One horizontal run of formula cells to restore: `values` are formula strings
// starting at (row, col), all 0-based and within the pushed grid.
export type FormulaRun = { row: number; col: number; formulas: string[] }

// values.batchUpdate at USER_ENTERED - the only write in this module that lets
// Sheets interpret a cell, and it only ever receives formula text that was
// already in the sheet. Every value that originates from the database goes
// through writeGrid at RAW, so a product named "=cmd" can never be evaluated.
export async function writeFormulaRuns(spreadsheetId: string, tab: string, runs: FormulaRun[]): Promise<void> {
  if (runs.length === 0) return
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: runs.map((run) => ({
          range: `'${tab}'!${columnLetter(run.col)}${run.row + 1}`,
          values: [run.formulas],
        })),
      }),
    }),
    'write formulas'
  )
}

// drive.files.get - the sheet's last-modified time (RFC3339), or null when Drive
// won't say. Used by Push to spot edits made in the sheet since Cactus last
// synced it, before overwriting them. drive.file scope covers metadata on the
// app's own file, so no extra scope is needed. The sheet's own content edits
// bump this; the app's push writes bump it too, which is why the caller compares
// against the push/pull stamps (both taken AFTER the app's write) with a margin.
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
export async function getSheetModifiedTime(spreadsheetId: string): Promise<Date | null> {
  const res = await googleFetch(`${DRIVE_API}/${spreadsheetId}?fields=modifiedTime`, { method: 'GET' })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as { modifiedTime?: string } | null
  if (!data?.modifiedTime) return null
  const t = new Date(data.modifiedTime)
  return Number.isNaN(t.getTime()) ? null : t
}

// values.clear over an entire tab. Push no longer uses this - it clears only the
// rows and columns the catalogue has given up, so the owner's formulas and their
// own columns survive (see lib/push-grid.ts). Kept for a caller that genuinely
// wants the tab emptied.
export async function clearTab(spreadsheetId: string, tab: string): Promise<void> {
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values/${tabRange(tab)}:clear`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    'clear tab'
  )
}

// Map of tab title -> numeric sheetId, needed to target a tab in batchUpdate.
export async function getSheetIds(spreadsheetId: string): Promise<Record<string, number>> {
  const res = await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`, { method: 'GET' }),
    'read spreadsheet'
  )
  const data = (await res.json()) as { sheets?: Array<{ properties: { sheetId: number; title: string } }> }
  const ids: Record<string, number> = {}
  for (const s of data.sheets ?? []) ids[s.properties.title] = s.properties.sheetId
  return ids
}

// spreadsheets.batchUpdate - formatting and protection.
export async function batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
  if (requests.length === 0) return
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    }),
    'batch update'
  )
}
