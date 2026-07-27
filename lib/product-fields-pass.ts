import { resolveProductFieldProviders } from '@/modules/shop/lib/product-field-providers'
import { matchRowsToProducts } from '@/modules/google-sheet-products-for-shop/lib/row-products'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// shop's import engine only knows the fixed CSV columns, so a product-level
// attribute column (contributed through shop.product-field-provider) is invisible
// to it - a Pull that edits one would import "nothing changed". This pass fixes it
// AFTER the engine returns, entirely inside this module, the same way the
// designed-description pass handles the column the engine ignores. It walks the
// (already filtered) grid, matches each row to its product the way the engine
// does, and hands the row to every product-field provider to apply.

// `grid` is a header row plus the data rows to process (a whole chunk, so a Pull
// runs this alongside the products import chunk-by-chunk rather than in one
// unbounded pass over the entire catalogue). `sheetRowFor(dataIndex)` maps a
// 0-based data-row index within this grid to the row number the owner sees in
// their sheet, so a row error points at the right place; it defaults to the
// header-offset index when no map is supplied.
export async function applyProductFieldsPass(
  grid: string[][],
  opts?: { sheetRowFor?: (dataIndex: number) => number },
): Promise<{ updated: number; errors: SyncRowError[] }> {
  const errors: SyncRowError[] = []
  let updated = 0
  const sheetRowFor = opts?.sheetRowFor ?? ((dataIndex: number) => dataIndex + 2)

  const providers = await resolveProductFieldProviders()
  if (providers.length === 0 || grid.length < 2) return { updated, errors }

  // Read-only cross-module resolution, two batched queries, matching each row to
  // its product exactly as the import engine does.
  const { rawHeader, matches } = await matchRowsToProducts(grid)
  const productIds = new Set(matches.map((m) => m.productId).filter((id): id is string => !!id))

  // Let each provider preload its current state for every product in one go.
  const ctx = new Map<string, unknown>()
  for (const { id, provider } of providers) {
    if (provider.beginImport) ctx.set(id, await provider.beginImport([...productIds]))
  }

  for (const match of matches) {
    if (!match.productId) continue // the engine could not match it either; its own error stands
    const rowRecord: Record<string, string> = {}
    rawHeader.forEach((h, i) => { rowRecord[h] = (match.row[i] ?? '').trim() })
    let rowChanged = false
    for (const { id, provider } of providers) {
      try {
        if (await provider.applyImportedRow(match.productId, rowRecord, ctx.get(id))) rowChanged = true
      } catch (err) {
        errors.push({ row: sheetRowFor(match.dataIndex), reason: err instanceof Error ? err.message : 'Attribute update failed' })
      }
    }
    if (rowChanged) updated++
  }

  return { updated, errors }
}
