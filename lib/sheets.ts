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

// values.update, RAW - no cell is ever evaluated as a formula.
export async function writeGrid(spreadsheetId: string, tab: string, values: string[][]): Promise<void> {
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

// values.clear
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
