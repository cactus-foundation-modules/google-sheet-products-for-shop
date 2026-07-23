import { prisma } from '@/lib/db/prisma'
import { missingFormatColumns } from '@/modules/shop/lib/csv'
import { diffProductRows, diffVariationRows } from '@/modules/google-sheet-products-for-shop/lib/pull-diff'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import type { GspConnection, PullPreview, SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// The whole Pull, dry-run. Writes nothing. Built on the same row diff the Pull
// itself uses to decide which rows reach the importers (lib/pull-diff.ts), so the
// confirm dialog's counts are the Pull's counts - including "already match",
// which is exactly the set of rows the Pull will skip.
export async function buildPullPreview(productsGrid: string[][], variationsGrid: string[][], conn: GspConnection): Promise<PullPreview> {
  const headerMissing = missingFormatColumns(productsGrid[0] ?? [])

  const toCreate: PullPreview['products']['toCreate'] = []
  const toUpdate: PullPreview['products']['toUpdate'] = []
  const rowErrors: SyncRowError[] = []
  let productsUnchanged = 0

  // Only try to diff rows once the header is intact - column indices are
  // meaningless otherwise, and the caller surfaces headerMissing regardless.
  if (headerMissing.length === 0) {
    for (const r of await diffProductRows(productsGrid)) {
      if (r.kind === 'error') rowErrors.push({ row: r.row + 1, reason: r.reason })
      else if (r.kind === 'create') toCreate.push({ sku: r.sku, name: r.name })
      else if (r.kind === 'update') toUpdate.push({ sku: r.sku, name: r.name, changes: r.changes })
      else productsUnchanged++
    }
  }

  // Deletions (products + variations) come from the shared planner so the preview
  // shows exactly what the Pull will remove. A mangled header means we can't read
  // the sheet's identity columns, so we plan no deletions (and the Pull itself
  // refuses outright until the header is fixed).
  const plan = headerMissing.length === 0
    ? await planPullDeletions(productsGrid, variationsGrid, conn.lastPushAt)
    : { products: [], variations: [] }

  let staleness: PullPreview['staleness'] = { changedSinceLastPush: 0, since: null }
  if (conn.lastPushAt) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "shp_products"
      WHERE "catalogue_hidden" = false AND "updated_at" > ${conn.lastPushAt}
    `
    staleness = { changedSinceLastPush: Number(rows[0]?.count ?? 0), since: conn.lastPushAt.toISOString() }
  }

  const varResults = await diffVariationRows(variationsGrid)
  const variations = {
    toCreate: varResults.filter((r) => r.kind === 'create').length,
    toUpdate: varResults.filter((r) => r.kind === 'update').length,
    toDelete: plan.variations.length,
    unchanged: varResults.filter((r) => r.kind === 'unchanged').length,
    rowErrors: varResults.filter((r) => r.kind === 'error').map((r) => ({ row: r.row + 1, reason: r.reason ?? 'Invalid row' })),
  }

  return {
    products: { toCreate, toUpdate, toDelete: plan.products, unchanged: productsUnchanged, rowErrors },
    variations, staleness, headerMissing,
  }
}
