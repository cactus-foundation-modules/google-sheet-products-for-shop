import { bulkDeleteProducts } from '@/modules/shop/lib/db/products'
import type { ProductDeletion, VariantDeletion } from '@/modules/google-sheet-products-for-shop/lib/deletions'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

const msg = (err: unknown) => (err instanceof Error ? err.message : 'unknown error')

// Products the sheet no longer lists (and that predate the last push) are removed
// outright. Deleting a product cascades its variant children and svr_ rows away;
// order-line history survives via the ON DELETE SET NULL on shp_order_items.
export async function applyProductDeletions(products: ProductDeletion[]): Promise<{ deleted: number; errors: SyncRowError[] }> {
  if (products.length === 0) return { deleted: 0, errors: [] }
  try {
    const deleted = await bulkDeleteProducts(products.map((p) => p.id))
    return { deleted, errors: [] }
  } catch (err) {
    return { deleted: 0, errors: [{ row: 0, reason: `Could not delete ${products.length} product(s): ${msg(err)}` }] }
  }
}

// Variants pruned by the plan - each is a hidden child product, so the same
// bulk delete cascades its svr_variants + svr_variant_values rows.
export async function applyVariationDeletions(variations: VariantDeletion[]): Promise<{ deleted: number; errors: SyncRowError[] }> {
  if (variations.length === 0) return { deleted: 0, errors: [] }
  try {
    const deleted = await bulkDeleteProducts(variations.map((v) => v.childProductId))
    return { deleted, errors: [] }
  } catch (err) {
    return { deleted: 0, errors: [{ row: 0, reason: `Could not remove ${variations.length} variation(s): ${msg(err)}` }] }
  }
}
