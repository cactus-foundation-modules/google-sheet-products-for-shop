import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { listProducts } from '@/modules/shop/lib/db'
import { collectPaged } from '@/modules/shop/lib/csv'
import { slugify } from '@/modules/shop/lib/slug'
import { getEditorPayloadsBatch } from '@/modules/shop-variations/lib/variants-service'
import { getProductIdsWithVariations } from '@/modules/shop-variations/lib/db/variants'
import type { ShpProduct } from '@/modules/shop/lib/types'

// A variant is identified by its unordered set of option-value ids.
function comboKey(optionValueIds: string[]): string {
  return [...optionValueIds].sort().join('|')
}

export type ProductDeletion = { id: string; sku: string | null; name: string }
export type VariantDeletion = { childProductId: string; parentSlug: string; parentName: string; label: string }
export type PullDeletionPlan = { products: ProductDeletion[]; variations: VariantDeletion[] }

// Sheet product-row identity: a shop product counts as "still in the sheet" if
// its SKU matches a row's SKU, or its slug matches a row's slug - the same two
// ways the import engine matches a row back to an existing product.
//
// Both the row's own slug cell and slugify(its name) count. The slug column is
// the identity the importer prefers, but a row whose name was edited without its
// slug (or a sheet from before the slug column existed) must still be recognised
// - anything unrecognised here is a product this Pull would DELETE.
export function sheetProductIdentity(grid: string[][]): { skus: Set<string>; slugs: Set<string> } {
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const skuCol = header.indexOf('sku')
  const nameCol = header.indexOf('name')
  const slugCol = header.indexOf('slug')
  const skus = new Set<string>()
  const slugs = new Set<string>()
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? []
    const sku = skuCol >= 0 ? (row[skuCol] ?? '').trim() : ''
    if (sku) skus.add(sku)
    const name = nameCol >= 0 ? (row[nameCol] ?? '').trim() : ''
    if (name) slugs.add(slugify(name))
    const slug = slugCol >= 0 ? (row[slugCol] ?? '').trim() : ''
    if (slug) slugs.add(slugify(slug))
  }
  return { skus, slugs }
}

function presentInSheet(p: ShpProduct, identity: { skus: Set<string>; slugs: Set<string> }): boolean {
  if (p.sku && identity.skus.has(p.sku)) return true
  return identity.slugs.has(p.slug)
}

// created_at for a set of shp_products ids, in one query. Backs the push-baseline
// anchor below - the JS value is what we compare, never the SQL literal.
async function createdAtByIds(ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ id: string; created_at: Date }[]>`
    SELECT "id", "created_at" FROM "shp_products" WHERE "id" IN (${Prisma.join(ids)})
  `
  return new Map(rows.map((r) => [r.id, r.created_at]))
}

// The whole deletion side of a Pull, computed against current DB state. Used by
// BOTH the preview (for its counts/lists) and the Pull itself (to execute), so
// the confirm dialog can never disagree with what happens. Writes nothing.
//
// Safety anchor: we only ever remove something that was in the sheet as of the
// last Push (created_at <= lastPushAt). Push mirrors the whole catalogue, so a
// product or variant created in the admin AFTER the last push was never in the
// sheet - its absence means "not yet synced", not "deleted from the sheet". With
// no push on record there is no baseline at all, so we delete nothing.
export async function planPullDeletions(
  productsGrid: string[][],
  variationsGrid: string[][],
  lastPushAt: Date | null,
  allProducts?: ShpProduct[],
): Promise<PullDeletionPlan> {
  if (!lastPushAt) return { products: [], variations: [] }
  const pushMs = lastPushAt.getTime()

  const all = allProducts ?? await collectPaged<ShpProduct>(async (page) => {
    const { products, total } = await listProducts({ page, perPage: 100, excludeHidden: true })
    return { items: products, total }
  })
  const identity = sheetProductIdentity(productsGrid)

  // Products in the shop, absent from the sheet, that predate the last push.
  const products: ProductDeletion[] = all
    .filter((p) => !presentInSheet(p, identity) && p.createdAt.getTime() <= pushMs)
    .map((p) => ({ id: p.id, sku: p.sku, name: p.name }))
  const deletedIds = new Set(products.map((p) => p.id))

  // Parents that survive this pull (still in the sheet, not being deleted) - only
  // these are eligible for variation pruning. A deleted parent takes its variants
  // with it via cascade, counted under products, so it must not appear here too.
  const surviving = all.filter((p) => !deletedIds.has(p.id) && presentInSheet(p, identity))
  const survivingBySlug = new Map(surviving.map((p) => [p.slug, p]))
  const survivingIds = new Set(surviving.map((p) => p.id))

  // --- variations ---
  const header = (variationsGrid[0] ?? []).map((h) => h.trim())
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const slugCol = idx('Parent Slug')
  const optionPairs: Array<{ nameCol: number; valueCol: number }> = []
  if (slugCol >= 0) {
    for (let i = 1; ; i++) {
      const nameCol = idx(`Option ${i}`)
      const valueCol = idx(`Value ${i}`)
      if (nameCol < 0 || valueCol < 0) break
      optionPairs.push({ nameCol, valueCol })
    }
  }

  // Group the sheet's variation rows by parent slug (parents that still have rows).
  const rowsBySlug = new Map<string, string[][]>()
  if (slugCol >= 0) {
    for (let r = 1; r < variationsGrid.length; r++) {
      const cols = variationsGrid[r] ?? []
      const slug = (cols[slugCol] ?? '').trim()
      if (!slug) continue
      const list = rowsBySlug.get(slug) ?? []
      list.push(cols)
      rowsBySlug.set(slug, list)
    }
  }

  const candidates: VariantDeletion[] = []
  const handled = new Set<string>()

  // Every parent this function will ever look at - the partial case (still has
  // sheet rows) and the empty case (variants but no rows left) below - fetched in
  // one batch rather than once per parent per case. A catalogue with hundreds of
  // variant parents used to mean that many getEditorPayload round trips, twice
  // over on a Pull (once from the preview, once from the run itself).
  const withVariants = await getProductIdsWithVariations()
  const partialParentIds = new Set(
    [...rowsBySlug.keys()].map((slug) => survivingBySlug.get(slug)?.id).filter((id): id is string => !!id),
  )
  const emptyParentIds = withVariants.filter((id) => survivingIds.has(id) && !partialParentIds.has(id))
  const neededIds = new Set([...partialParentIds, ...emptyParentIds])
  const payloadByParentId = await getEditorPayloadsBatch(surviving.filter((p) => neededIds.has(p.id)))

  // Partial case: a parent that still has rows, minus the combos those rows list.
  for (const [slug, rows] of rowsBySlug) {
    const parent = survivingBySlug.get(slug)
    if (!parent) continue // parent gone or not in the sheet -> products pass owns it
    const payload = payloadByParentId.get(parent.id)
    if (!payload) continue
    handled.add(parent.id)

    const valueIdByKey = new Map<string, string>()
    for (const o of payload.options) for (const v of o.values) valueIdByKey.set(`${o.name.toLowerCase()}|${v.label.toLowerCase()}`, v.id)

    const wanted = new Set<string>()
    for (const cols of rows) {
      const ids: string[] = []
      let resolvable = true
      for (const pair of optionPairs) {
        const optName = (cols[pair.nameCol] ?? '').trim()
        const valLabel = (cols[pair.valueCol] ?? '').trim()
        if (!optName || !valLabel) continue
        const id = valueIdByKey.get(`${optName.toLowerCase()}|${valLabel.toLowerCase()}`)
        if (!id) { resolvable = false; break }
        ids.push(id)
      }
      if (resolvable && ids.length) wanted.add(comboKey(ids))
    }

    for (const v of payload.variants) {
      if (v.optionValueIds.length === 0) continue
      if (wanted.has(comboKey(v.optionValueIds))) continue
      candidates.push({ childProductId: v.childProductId, parentSlug: slug, parentName: parent.name, label: v.label })
    }
  }

  // Empty case: a surviving parent that has variants but no rows left in the sheet
  // - the owner cleared its whole block, so every variant it has is unwanted.
  for (const parentId of withVariants) {
    if (!survivingIds.has(parentId) || handled.has(parentId)) continue
    const payload = payloadByParentId.get(parentId)
    if (!payload) continue
    for (const v of payload.variants) {
      if (v.optionValueIds.length === 0) continue
      candidates.push({ childProductId: v.childProductId, parentSlug: payload.product.slug, parentName: payload.product.name, label: v.label })
    }
  }

  // Apply the push-baseline anchor: keep only variants whose child product was in
  // the sheet as of the last push. A variant added in the admin since then was
  // never in the sheet, so its absence is not a delete signal.
  const createdAt = await createdAtByIds(candidates.map((c) => c.childProductId))
  const variations = candidates.filter((c) => {
    const ts = createdAt.get(c.childProductId)
    return ts != null && ts.getTime() <= pushMs
  })

  return { products, variations }
}
