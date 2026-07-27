import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { slugify } from '@/modules/shop/lib/slug'

// Matching a Products row to the product it stands for, exactly the way shop's
// import engine does it: SKU when the row carries one, else the slug the row
// gives (or the one its name derives). Every pass that fixes up a column the
// engine cannot see needs the same answer, so they share this rather than each
// keeping a copy that can drift out of step with the engine.

export type ProductRowMatch = {
  /** 0-based index into the grid's DATA rows (grid row index minus the header). */
  dataIndex: number
  row: string[]
  /** Unset when no product answers to this row - the engine could not match it
   *  either, and its own row error stands. */
  productId?: string
}

export type MatchedRows = {
  /** The header as typed, for records handed to providers keyed by column label. */
  rawHeader: string[]
  /** Header normalised to CSV column names (lowercased, spaces to underscores). */
  header: string[]
  matches: ProductRowMatch[]
}

// `grid` is a header row plus the data rows to process. Two batched read-only
// queries, whatever the row count.
export async function matchRowsToProducts(grid: string[][]): Promise<MatchedRows> {
  const rawHeader = (grid[0] ?? []).map((h) => h.trim())
  const header = rawHeader.map((h) => h.toLowerCase().replace(/\s+/g, '_'))
  const empty: MatchedRows = { rawHeader, header, matches: [] }
  if (grid.length < 2) return empty

  const skuCol = header.indexOf('sku')
  const nameCol = header.indexOf('name')
  const slugCol = header.indexOf('slug')
  if (skuCol < 0 && nameCol < 0 && slugCol < 0) return empty

  type Pending = ProductRowMatch & { sku: string; slug: string }
  const pending: Pending[] = []
  const skus = new Set<string>()
  const slugs = new Set<string>()
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? []
    const sku = skuCol >= 0 ? (row[skuCol] ?? '').trim() : ''
    const name = nameCol >= 0 ? (row[nameCol] ?? '').trim() : ''
    const slug = slugify((slugCol >= 0 ? (row[slugCol] ?? '').trim() : '') || name)
    pending.push({ dataIndex: r - 1, row, sku, slug })
    if (sku) skus.add(sku)
    else if (slug) slugs.add(slug)
  }

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

  for (const p of pending) {
    const id = p.sku ? idBySku.get(p.sku) : p.slug ? idBySlug.get(p.slug) : undefined
    if (id) p.productId = id
  }
  return { rawHeader, header, matches: pending }
}
