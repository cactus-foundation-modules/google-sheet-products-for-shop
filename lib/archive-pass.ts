import { prisma } from '@/lib/db/prisma'
import { updateProduct } from '@/modules/shop/lib/db/products'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// Decision 3: a row deleted from the sheet is NOT a delete. Neither import engine
// removes anything, and deleting a product with order history on a sync-button
// press is not something we do. Instead, rows the admin explicitly ticked in the
// preview are ARCHIVED (reversible, keeps order history, already a valid status).
// Nothing here happens unless a sku was ticked - the default action is nothing.
export async function applyArchivePass(opts: {
  archiveSkus: string[]
  sheetSkus: Set<string>
}): Promise<{ archived: number; errors: SyncRowError[] }> {
  const errors: SyncRowError[] = []
  let archived = 0

  for (const raw of opts.archiveSkus) {
    const sku = raw.trim()
    if (!sku) continue
    // Belt and braces: never archive something that is actually on the sheet,
    // even if the client asked us to (stale preview / tampered request).
    if (opts.sheetSkus.has(sku)) {
      errors.push({ row: 0, reason: `Skipped archiving ${sku}: it is present in the sheet` })
      continue
    }
    const rows = await prisma.$queryRaw<{ id: string; status: string; catalogue_hidden: boolean }[]>`
      SELECT "id", "status", "catalogue_hidden" FROM "shp_products" WHERE "sku" = ${sku} LIMIT 1
    `
    const product = rows[0]
    // Variant children are catalogue_hidden and out of scope for this tab.
    if (!product || product.catalogue_hidden) continue
    if (product.status !== 'ARCHIVED') {
      await updateProduct(product.id, { status: 'ARCHIVED' })
      archived++
    }
  }

  return { archived, errors }
}
