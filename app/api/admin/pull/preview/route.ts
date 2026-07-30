import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getLatestUnfinishedPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { readGrid, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { TAB } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { readMergedVariations } from '@/modules/google-sheet-products-for-shop/lib/pull-variations'
import { slugsInMergedGrid, missingManifestSlugs } from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'
import { buildPullPreview } from '@/modules/google-sheet-products-for-shop/lib/preview'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import { CSV_COLUMNS } from '@/modules/shop/lib/csv'

// TEMP DIAGNOSTIC (remove after the Markup/Range pull investigation): dumps, for
// every Products row the live site just read, exactly what came back from the
// sheet in the NON-fixed (attribute) columns - so we can see whether the owner's
// new Markup/Range value actually reached the read the diff runs against. Fixed
// shop columns are omitted to keep it small. Logged server-side AND returned on
// the response under `debug`.
function buildAttributeReadDebug(productsGrid: string[][]) {
  const header = (productsGrid[0] ?? []).map((h) => h.trim())
  const fixed = new Set<string>(CSV_COLUMNS)
  const attrCols = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h !== '' && !fixed.has(h.toLowerCase().replace(/\s+/g, '_')))
  const slugCol = header.findIndex((h) => h.toLowerCase() === 'slug')
  const nameCol = header.findIndex((h) => h.toLowerCase() === 'name')
  const rows: Array<{ row: number; slug: string; name: string; attrs: Record<string, string> }> = []
  for (let r = 1; r < productsGrid.length; r++) {
    const cells = productsGrid[r] ?? []
    const attrs: Record<string, string> = {}
    for (const { h, i } of attrCols) attrs[h] = (cells[i] ?? '').trim()
    rows.push({
      row: r + 1,
      slug: slugCol >= 0 ? (cells[slugCol] ?? '').trim() : '',
      name: nameCol >= 0 ? (cells[nameCol] ?? '').trim() : '',
      attrs,
    })
  }
  return { attributeColumns: attrCols.map((c) => c.h), rows }
}

// Reads both tabs, resolves them against the DB, returns a summary, writes
// NOTHING. The confirm dialog lists exactly this before POST /pull runs it.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Refuse while a Push is part-way through, before touching Google at all. A
  // running push is spending the same sixty-reads-a-minute quota this preview
  // needs, so the preview's reads queue behind it, blow the route's sixty-second
  // ceiling, and the owner sees "could not read the sheet" about a sheet that is
  // fine. It is also rewriting the very tabs the preview would read - a torn
  // snapshot even when it does squeak in. Mirrors the guard Push has against a
  // running Pull.
  if (await getLatestUnfinishedPushJob()) {
    return errorResponse('A push to the sheet is part-way through. Open Push and let it finish (or cancel it), then pull.', 409)
  }

  // Two failures with nothing in common: Google would not give us the grids, or
  // the catalogue comparison behind them fell over. They were once caught
  // together and both reported as "could not read the Google Sheet", which sent
  // an owner off resetting a spreadsheet that was never the problem - a database
  // blip mid-comparison read as a broken sheet. Caught separately, and each one
  // says what actually happened.
  let productsGrid: string[][]
  let variationsGrid: string[][]
  try {
    ;[productsGrid, variationsGrid] = await Promise.all([
      readGrid(conn.spreadsheetId, TAB.PRODUCTS),
      readMergedVariations(conn.spreadsheetId),
    ])
  } catch (err) {
    if (err instanceof GoogleAuthError) return errorResponse(err.message, 400)
    const reason = sheetFailureReason(err)
    console.error('[google-sheet-products-for-shop/preview] sheet read failed:', reason)
    return errorResponse(`Could not read the Google Sheet. ${reason}`, 502)
  }

  // Same guard the Pull itself uses: a product tab renamed or deleted since the
  // last Push would read as "these variants are gone". Refuse rather than preview a
  // mass deletion the owner never intended.
  const manifest = conn.variationTabManifest ?? []
  if (manifest.length > 0) {
    const present = slugsInMergedGrid(variationsGrid)
    const missingSlugs = missingManifestSlugs(manifest.map((m) => m.slug), present)
    if (missingSlugs.length > 0) {
      const titles = manifest.filter((m) => missingSlugs.includes(m.slug)).map((m) => `"${m.title}"`)
      return errorResponse(
        `These product tabs are missing from your sheet: ${titles.join(', ')}. A tab has been renamed, deleted or emptied since your last Push. Restore it (or Push again) before pulling.`,
        400,
      )
    }
  }

  try {
    const preview = await buildPullPreview(productsGrid, variationsGrid, conn)
    // TEMP DIAGNOSTIC (remove after the Markup/Range pull investigation).
    const debug = {
      sheetRead: buildAttributeReadDebug(productsGrid),
      // What the diff decided per product, so the sheet read above can be lined
      // up against the update/unchanged verdict for the same row.
      productVerdicts: [
        ...preview.products.toUpdate.map((u) => ({
          name: u.name,
          kind: 'update' as const,
          changes: u.changes.map((c) => `${c.field}: "${c.from}" -> "${c.to}"`),
        })),
        { note: `${preview.products.unchanged} product row(s) read as unchanged` },
      ],
    }
    console.error('[gsp/preview][TEMP-DIAG]', JSON.stringify(debug))
    return NextResponse.json({ preview, debug })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error'
    console.error('[google-sheet-products-for-shop/preview] comparison failed:', reason)
    return errorResponse(`Read the sheet fine, but comparing it with your catalogue failed: ${reason}`, 500)
  }
}
