import { importVariationsCsv, type ImportResult } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { getSheetIds, readHeaderRows, readGridsBatch } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { RESERVED_TAB_TITLES, isVariationTab, mergeVariationTabs } from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'

// Sheet grid -> shop-variations' importer. importVariationsCsv groups rows by
// parent slug, auto-creates any option/value it hasn't seen, and matches variants
// by exact value-set, so it round-trips. It returns counts synchronously - no
// job row needed. Parents must already exist (the importer will not create them),
// which is why Products is always pulled first.
export async function pullVariations(grid: string[][]): Promise<ImportResult> {
  return importVariationsCsv(gridToImportCsv(grid))
}

// Read every per-product variation tab and merge them into the single wide grid
// the Pull pipeline works off - the exact shape the old single "Variations" tab
// produced. A variation tab is any non-reserved tab whose header carries "Parent
// Slug" (anywhere, not just A1 - the owner may have rearranged the columns); the
// owner's own tabs, having no such marker, are never mistaken for catalogue tabs,
// so an added notes tab never breaks a Pull. Returns [] when there are no
// variation tabs at all (an all-simple catalogue), which the pipeline reads as
// "no variations".
//
// Reads are batched, not per-tab: this whole read happens inside one module route
// capped at sixty seconds, against a Google quota of sixty reads a minute. Read
// one call per tab, a few hundred product tabs queue for minutes and the route
// 504s before the sheet is even in hand. So: header rows of every candidate
// first (batched - and only one row, so an owner's own big tab costs a row, not
// its contents), then the full body of just the tabs that proved to be variation
// tabs, forty-odd per call.
export async function readMergedVariations(spreadsheetId: string): Promise<string[][]> {
  const ids = await getSheetIds(spreadsheetId)
  const candidates = Object.keys(ids).filter((t) => !RESERVED_TAB_TITLES.has(t))
  if (candidates.length === 0) return []
  const headers = await readHeaderRows(spreadsheetId, candidates)
  const variationTabs = candidates.filter((t) => isVariationTab(t, headers[t] ?? []))
  if (variationTabs.length === 0) return []
  const grids = await readGridsBatch(spreadsheetId, variationTabs)
  return mergeVariationTabs(variationTabs.map((t) => grids[t] ?? []))
}
