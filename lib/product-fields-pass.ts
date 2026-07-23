import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { slugify } from '@/modules/shop/lib/slug'
import { resolveProductFieldProviders } from '@/modules/shop/lib/product-field-providers'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// shop's import engine only knows the fixed CSV columns, so a product-level
// attribute column (contributed through shop.product-field-provider) is invisible
// to it - a Pull that edits one would import "nothing changed". This pass fixes it
// AFTER the engine returns, entirely inside this module, the same way the status
// pass handles the column the engine ignores. It walks the (already filtered) grid,
// matches each row to its product the way the engine does, and hands the row to
// every product-field provider to apply.

export async function applyProductFieldsPass(grid: string[][]): Promise<{ updated: number; errors: SyncRowError[] }> {
  const errors: SyncRowError[] = []
  let updated = 0

  const providers = await resolveProductFieldProviders()
  if (providers.length === 0 || grid.length < 2) return { updated, errors }

  const rawHeader = (grid[0] ?? []).map((h) => h.trim())
  const lower = rawHeader.map((h) => h.toLowerCase().replace(/\s+/g, '_'))
  const skuCol = lower.indexOf('sku')
  const nameCol = lower.indexOf('name')
  const slugCol = lower.indexOf('slug')
  if (skuCol < 0 && nameCol < 0 && slugCol < 0) return { updated, errors }

  // Each data row's identity, exactly as the import engine and the status pass
  // resolve it: SKU when the row has one, else the slug derived from an explicit
  // slug or the name.
  type RowInfo = { r: number; row: string[]; sku: string; slug: string; productId?: string }
  const infos: RowInfo[] = []
  const skus = new Set<string>()
  const slugs = new Set<string>()
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? []
    const sku = skuCol >= 0 ? (row[skuCol] ?? '').trim() : ''
    const name = nameCol >= 0 ? (row[nameCol] ?? '').trim() : ''
    const slug = slugify((slugCol >= 0 ? (row[slugCol] ?? '').trim() : '') || name)
    infos.push({ r, row, sku, slug })
    if (sku) skus.add(sku)
    else if (slug) slugs.add(slug)
  }

  // Read-only cross-module resolution, two batched queries.
  const idBySku = new Map<string, string>()
  const idBySlug = new Map<string, string>()
  if (skus.size > 0) {
    const rows = await prisma.$queryRaw<{ id: string; sku: string | null }[]>`
      SELECT "id", "sku" FROM "shp_products" WHERE "sku" IN (${Prisma.join([...skus])})
    `
    for (const x of rows) if (x.sku) idBySku.set(x.sku, x.id)
  }
  if (slugs.size > 0) {
    const rows = await prisma.$queryRaw<{ id: string; slug: string }[]>`
      SELECT "id", "slug" FROM "shp_products" WHERE "slug" IN (${Prisma.join([...slugs])})
    `
    for (const x of rows) idBySlug.set(x.slug, x.id)
  }

  const productIds = new Set<string>()
  for (const info of infos) {
    const id = info.sku ? idBySku.get(info.sku) : info.slug ? idBySlug.get(info.slug) : undefined
    if (id) {
      info.productId = id
      productIds.add(id)
    }
  }

  // Let each provider preload its current state for every product in one go.
  const ctx = new Map<string, unknown>()
  for (const { id, provider } of providers) {
    if (provider.beginImport) ctx.set(id, await provider.beginImport([...productIds]))
  }

  for (const info of infos) {
    if (!info.productId) continue // the engine could not match it either; its own error stands
    const rowRecord: Record<string, string> = {}
    rawHeader.forEach((h, i) => { rowRecord[h] = (info.row[i] ?? '').trim() })
    let rowChanged = false
    for (const { id, provider } of providers) {
      try {
        if (await provider.applyImportedRow(info.productId, rowRecord, ctx.get(id))) rowChanged = true
      } catch (err) {
        errors.push({ row: info.r + 1, reason: err instanceof Error ? err.message : 'Attribute update failed' })
      }
    }
    if (rowChanged) updated++
  }

  return { updated, errors }
}
