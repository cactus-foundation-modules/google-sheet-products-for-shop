import { importVariationsCsv, type ImportResult } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'
import { getSheetIds, readGrid } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { RESERVED_TAB_TITLES, mergeVariationTabs } from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'

// Sheet grid -> shop-variations' importer. importVariationsCsv groups rows by
// parent slug, auto-creates any option/value it hasn't seen, and matches variants
// by exact value-set, so it round-trips. It returns counts synchronously - no
// job row needed. Parents must already exist (the importer will not create them),
// which is why Products is always pulled first.
export async function pullVariations(grid: string[][]): Promise<ImportResult> {
  return importVariationsCsv(gridToImportCsv(grid))
}

// Read at most this many product tabs at once. Google allows ~60 reads a minute;
// a bounded fan-out keeps a big catalogue's Pull-start fast (wall-clock ~= slowest
// batch, not the sum) without risking the quota on a hundred-tab workbook.
const READ_CONCURRENCY = 10

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

// Read every per-product variation tab and merge them into the single wide grid
// the Pull pipeline works off - the exact shape the old single "Variations" tab
// produced. A variation tab is any non-reserved tab carrying "Parent Slug" in A1;
// the owner's own tabs (no such marker) are read but discarded, so an added notes
// tab never breaks a Pull. Returns [] when there are no variation tabs at all
// (an all-simple catalogue), which the pipeline reads as "no variations".
export async function readMergedVariations(spreadsheetId: string): Promise<string[][]> {
  const ids = await getSheetIds(spreadsheetId)
  const candidates = Object.keys(ids).filter((t) => !RESERVED_TAB_TITLES.has(t))
  if (candidates.length === 0) return []
  const grids = await mapLimit(candidates, READ_CONCURRENCY, (t) => readGrid(spreadsheetId, t))
  const variationGrids = grids.filter((g) => ((g[0] ?? [])[0] ?? '').trim() === 'Parent Slug')
  if (variationGrids.length === 0) return []
  return mergeVariationTabs(variationGrids)
}
