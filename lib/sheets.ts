import { getAccessToken, GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import {
  awaitSlot, sleep, shouldBackOff, backoffMs, MAX_BACKOFF_RETRIES,
} from '@/modules/google-sheet-products-for-shop/lib/rate-limit'
import { tabRange, batchGetGroups } from '@/modules/google-sheet-products-for-shop/lib/batch-ranges'
import type { SheetGrid } from '@/modules/google-sheet-products-for-shop/lib/capacity'

// Thin fetch wrapper over the five Sheets/Drive REST calls this module needs.
// Deliberately no `googleapis` dependency: that package is enormous with a large
// transitive tree, new dependencies need sign-off, and five REST calls do not
// justify either.

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

// One access-token-bearing request, with a single refresh-and-retry on a 401
// (never a loop). getAccessToken(true) forces a refresh and persists the new
// token, so the retry reads a fresh one.
//
// Every call also waits for a slot in the matching rate bucket first, and backs off
// and retries when Google says 429 anyway. Both live here rather than at the call
// sites so no future Sheets call can forget them.
async function googleFetch(url: string, init: RequestInit, allowRetry = true): Promise<Response> {
  const isRead = (init.method ?? 'GET').toUpperCase() === 'GET'
  for (let attempt = 0; ; attempt++) {
    await awaitSlot(isRead)
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
    if (attempt < MAX_BACKOFF_RETRIES && shouldBackOff(res.status, isRead)) {
      const wait = backoffMs(res, attempt)
      // Drain the body before dropping the response, so the connection is released
      // back to the pool rather than left hanging until it is collected.
      await res.text().catch(() => '')
      await sleep(wait)
      continue
    }
    return res
  }
}

// A Sheets/Drive call that came back with a status we cannot use. Carries the
// pieces a caller needs to tell the owner what actually went wrong, so a route
// no longer has to flatten every cause into one "could not read the sheet".
export class SheetsApiError extends Error {
  readonly status: number
  readonly what: string
  // Google's own one-line explanation, e.g. "Unable to parse range: 'Products'".
  readonly googleMessage: string
  constructor(what: string, status: number, googleMessage: string) {
    super(`Google Sheets ${what} failed: ${status} ${googleMessage}`)
    this.name = 'SheetsApiError'
    this.what = what
    this.status = status
    this.googleMessage = googleMessage
  }
}

// Google's error bodies are JSON ({ error: { message } }) on every documented
// failure, but a proxy or a quota page can return HTML instead, so fall back to
// the raw text rather than losing the reason entirely.
function googleErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    if (parsed?.error?.message) return parsed.error.message
  } catch {
    // not JSON - fall through
  }
  return text.trim().slice(0, 300) || 'no detail given'
}

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  if (res.status === 401 || res.status === 403) {
    throw new GoogleAuthError(`Google refused the ${what} request (${res.status}). Reconnect the account on the settings page.`)
  }
  const text = await res.text().catch(() => '')
  throw new SheetsApiError(what, res.status, googleErrorMessage(text))
}

// One sentence an owner can act on, for anything thrown while talking to Google.
// Never a stack trace, and never Google's raw body beyond its message line - the
// two named cases below are the ones that actually reach support:
//   - a renamed or deleted tab, which no amount of resetting the sheet fixes
//   - Google being slow enough to hit the 30s per-call timeout above
export function sheetFailureReason(err: unknown): string {
  if (err instanceof SheetsApiError) {
    // Google caps how many times a minute one account may read from or write to a
    // sheet. Big catalogues reach it, and its own wording ("Quota exceeded for
    // quota metric 'Read requests'... consumer 'project_number:...'") means nothing
    // to a site owner. It clears on its own, so say so and say when.
    if (err.status === 429) {
      return 'Google is limiting how fast it will let us read and write this sheet, which happens on a big catalogue. Nothing is broken and nothing has been lost. Wait a minute, then carry on from where it stopped.'
    }
    if (/unable to parse range/i.test(err.googleMessage)) {
      return `Google could not find that tab in your spreadsheet (${err.googleMessage}). A tab has been renamed or deleted - restore the "Products" and "Variations" tab names, or create the sheet again from the settings page.`
    }
    return `Google refused the request (${err.status}): ${err.googleMessage}`
  }
  // AbortSignal.timeout rejects with a TimeoutError DOMException.
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'Google took too long to answer (over 30 seconds). Try again in a minute.'
  }
  return err instanceof Error ? err.message : 'Unknown error'
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

// Batched spreadsheets.get with grid data: readGridWithFormulas for MANY tabs in
// as few calls as the URL length allows. One call is ONE token against the read
// quota however many tabs it carries - the same economics that made Pull's
// readGridsBatch viable, applied to the Push's per-tab pre-read (which used to be
// one spreadsheets.get, and one quota token, per tab). Tabs come back keyed by
// title; a tab Google did not return (deleted mid-push) is simply absent, exactly
// as readGridWithFormulas would have returned an empty grid.
export async function readGridsWithFormulasBatch(spreadsheetId: string, tabs: string[]): Promise<Record<string, SheetCell[][]>> {
  const out: Record<string, SheetCell[][]> = {}
  if (tabs.length === 0) return out
  const fields = encodeURIComponent('sheets(properties.title,data.rowData.values(userEnteredValue,effectiveValue))')
  for (const group of batchGetGroups(tabs)) {
    const ranges = group.map((t) => `ranges=${tabRange(t)}`).join('&')
    const res = await ok(
      await googleFetch(`${SHEETS_API}/${spreadsheetId}?${ranges}&includeGridData=true&fields=${fields}`, {
        method: 'GET',
      }),
      'read grids with formulas'
    )
    const data = (await res.json()) as {
      sheets?: Array<{
        properties?: { title?: string }
        data?: Array<{ rowData?: Array<{ values?: Array<{ userEnteredValue?: ExtendedValue; effectiveValue?: ExtendedValue }> }> }>
      }>
    }
    // Sheets are matched by TITLE, not request order: the response carries one
    // entry per sheet that matched a range, in the spreadsheet's own tab order.
    for (const sheet of data.sheets ?? []) {
      const title = sheet.properties?.title
      if (title === undefined) continue
      const rowData = sheet.data?.[0]?.rowData ?? []
      out[title] = rowData.map((row) =>
        (row.values ?? []).map((cell) => ({
          formula: cell.userEnteredValue?.formulaValue ?? null,
          value: stringifyExtended(cell.effectiveValue),
          error: cell.effectiveValue?.errorValue !== undefined,
        }))
      )
    }
  }
  return out
}

// values.batchUpdate at RAW for MANY whole-tab grids in one call - the batched
// twin of writeGrid, and one write-quota token however many tabs it carries. The
// RAW guarantee is the same: no cell is ever evaluated.
export async function writeGridsBatch(spreadsheetId: string, writes: Array<{ tab: string; values: CellValue[][] }>): Promise<void> {
  if (writes.length === 0) return
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: writes.map((w) => ({ range: `'${w.tab}'!A1`, values: w.values })),
      }),
    }),
    'write grids'
  )
}

// values.batchClear over ranges that may span several tabs - one write-quota
// token for what clearRange spent one on PER range.
export async function batchClearRanges(spreadsheetId: string, ranges: Array<{ tab: string; a1: string }>): Promise<void> {
  if (ranges.length === 0) return
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchClear`, {
      method: 'POST',
      body: JSON.stringify({ ranges: ranges.map((r) => `'${r.tab}'!${r.a1}`) }),
    }),
    'clear ranges'
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
// through writeGrid/writeGridsBatch at RAW, so a product named "=cmd" can never
// be evaluated. Runs carry their tab so one call restores across every tab a
// batched push touched.
export async function writeFormulaRuns(spreadsheetId: string, runs: Array<FormulaRun & { tab: string }>): Promise<void> {
  if (runs.length === 0) return
  const body = JSON.stringify({
    valueInputOption: 'USER_ENTERED',
    data: runs.map((run) => ({
      range: `'${run.tab}'!${columnLetter(run.col)}${run.row + 1}`,
      values: [run.formulas],
    })),
  })
  // Unlike every other write in this module, the restore is preceded by a write
  // that has ALREADY flattened these cells to plain values. A transient failure
  // here therefore erases every surviving formula for good, with nothing to try
  // again from. 429 is now retried for every call inside googleFetch; what is left
  // to handle here is 5xx, which googleFetch deliberately does not retry on a write
  // (it may have been applied). Re-sending this particular one is safe: it writes
  // fixed formula text to fixed cells, so applying it twice is applying it once.
  let lastRes: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, { method: 'POST', body })
    if (res.ok) return
    if (res.status >= 500) {
      lastRes = res
      if (attempt < 2) await sleep(400 * 2 ** attempt)
      continue
    }
    await ok(res, 'write formulas') // non-retryable - throws
    return
  }
  await ok(lastRes!, 'write formulas') // retries exhausted - throw the last failure
}

// values.batchUpdate at RAW for a handful of scattered cells - the flatten-back
// path when a preserved formula's post-push result no longer matches the database
// (a precedent changed in the same push). Same RAW guarantee as writeGrid: no
// cell is ever evaluated. Cells carry their tab for the same reason formula runs do.
export async function writeRawCells(spreadsheetId: string, cells: Array<{ tab: string; row: number; col: number; value: CellValue }>): Promise<void> {
  if (cells.length === 0) return
  await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: cells.map((c) => ({ range: `'${c.tab}'!${columnLetter(c.col)}${c.row + 1}`, values: [[c.value]] })),
      }),
    }),
    'flatten formulas'
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

// Map of tab title -> sheetId AND grid size. The same call getSheetIds makes,
// asking for two more fields: Google counts a workbook's cells across every tab
// whether anything is in them or not, so anything that has to stay under that
// ceiling needs the sizes, not just the ids (see lib/capacity.ts).
export async function getSheetGrids(spreadsheetId: string): Promise<Record<string, SheetGrid>> {
  const res = await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`, { method: 'GET' }),
    'read spreadsheet'
  )
  const data = (await res.json()) as {
    sheets?: Array<{ properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }>
  }
  const out: Record<string, SheetGrid> = {}
  for (const s of data.sheets ?? []) {
    out[s.properties.title] = {
      sheetId: s.properties.sheetId,
      rowCount: s.properties.gridProperties?.rowCount ?? 0,
      columnCount: s.properties.gridProperties?.columnCount ?? 0,
    }
  }
  return out
}

// Add one tab to an existing workbook and return its sheetId. Used for tabs
// introduced after a workbook was created: every install made before the tab
// existed still has to grow one, and nobody is going to recreate their sheet for
// it. Returns null when the tab is already there.
export async function addTab(spreadsheetId: string, title: string, index?: number): Promise<number | null> {
  const existing = await getSheetIds(spreadsheetId)
  if (existing[title] !== undefined) return null
  const res = await ok(
    await googleFetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title, ...(index === undefined ? {} : { index }) } } }],
      }),
    }),
    'add tab'
  )
  const data = (await res.json()) as { replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> }
  return data.replies?.[0]?.addSheet?.properties?.sheetId ?? null
}

// Delete one or more tabs by sheetId, in a single batchUpdate. Used by a Push to
// remove the tab of a product that is no longer variable (or one the owner
// renamed away from the catalogue). A no-op on an empty list.
export async function deleteSheets(spreadsheetId: string, sheetIds: number[]): Promise<void> {
  if (sheetIds.length === 0) return
  await batchUpdate(spreadsheetId, sheetIds.map((sheetId) => ({ deleteSheet: { sheetId } })))
}

// values.batchGet of the HEADER ROW of each named tab, as a map of tab title ->
// that row's cells. Lets a caller classify tabs - a variation tab carries a
// "Parent Slug" column, an owner's own tab does not - without a read per tab.
// The whole row rather than A1 alone, because the owner may have dragged that
// column somewhere else. Grouped by batchGetGroups so a several-hundred-tab
// workbook cannot push the request URL past what Google accepts; each group is
// one call against the read quota.
export async function readHeaderRows(spreadsheetId: string, tabs: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const group of batchGetGroups(tabs, '1:1')) {
    const ranges = group.map((t) => `ranges=${tabRange(t, '1:1')}`).join('&')
    const res = await ok(
      await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`, { method: 'GET' }),
      'read first cells'
    )
    const data = (await res.json()) as { valueRanges?: Array<{ values?: unknown[][] }> }
    // valueRanges come back in the order the ranges were requested.
    ;(data.valueRanges ?? []).forEach((vr, i) => {
      const title = group[i]
      if (title === undefined) return
      out[title] = (vr.values?.[0] ?? []).map((cell) => (cell == null ? '' : String(cell)))
    })
  }
  return out
}

// values.batchGet of WHOLE tabs, as a map of tab title -> grid, stringified
// exactly as readGrid stringifies a single tab. This is what lets a Pull read a
// big workbook at all: one values.get per product tab meant one quota token per
// tab against Google's sixty reads a minute, so a workbook past ~a hundred tabs
// spent longer queuing for Google than the sixty seconds a module route gets to
// answer, and the owner saw only a timeout. Grouped the same way as
// readHeaderRows: each group is ONE read against the quota, however many tabs it
// carries.
export async function readGridsBatch(spreadsheetId: string, tabs: string[]): Promise<Record<string, string[][]>> {
  const out: Record<string, string[][]> = {}
  for (const group of batchGetGroups(tabs)) {
    const ranges = group.map((t) => `ranges=${tabRange(t)}`).join('&')
    const res = await ok(
      await googleFetch(`${SHEETS_API}/${spreadsheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`, { method: 'GET' }),
      'read grids'
    )
    const data = (await res.json()) as { valueRanges?: Array<{ values?: unknown[][] }> }
    ;(data.valueRanges ?? []).forEach((vr, i) => {
      const title = group[i]
      if (title === undefined) return
      out[title] = (vr.values ?? []).map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
    })
  }
  return out
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
