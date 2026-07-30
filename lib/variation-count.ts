import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

// The variation-count column: how many variations each product has, which is
// exactly the number of rows on that product's own variation tab. Like the
// designed-description column it is this module's own rather than one of shop's
// CSV columns - but unlike that one it is READ-ONLY. It is derived from the
// variants themselves, so there is nothing sensible a Pull could do with an
// edited cell: variants are added and removed on the product's own tab, not by
// typing a bigger number here. The importer ignores any header it does not
// recognise (resolveColumnMap keeps only CSV_COLUMNS), and the Pull diff only
// compares columns it owns, so an owner who overtypes the cell changes nothing
// and gets the real figure back on the next Push.
export const VARIATIONS_COLUMN = 'variations'

// Variant counts for a set of parent product ids, in one grouped query. Counts
// every svr_variants row for the product, enabled or not - the same set
// exportVariationsCsv writes rows for (getVariants applies no enabled filter),
// so the number here always matches the length of that product's tab.
//
// shop-variations is a hard requirement of this module (requiresModules), so the
// table is always there; no existence check is needed.
export async function getVariationCounts(productIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (productIds.length === 0) return counts
  const rows = await prisma.$queryRaw<{ product_id: string; count: bigint }[]>`
    SELECT "product_id", COUNT(*)::bigint AS count
    FROM "svr_variants"
    WHERE "product_id" IN (${Prisma.join(productIds)})
    GROUP BY "product_id"
  `
  // COUNT comes back as a BigInt, which JSON.stringify throws on and which a
  // sheet cell cannot carry - narrow it here rather than at every call site.
  for (const r of rows) counts.set(r.product_id, Number(r.count))
  return counts
}
