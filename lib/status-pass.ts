import { prisma } from '@/lib/db/prisma'
import { updateProduct } from '@/modules/shop/lib/db/products'
import { slugify } from '@/modules/shop/lib/slug'
import type { ShpProductStatus } from '@/modules/shop/lib/types'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// shop's import engine never reads the `status` column - new products are forced
// to DRAFT and existing ones keep whatever they have. So a site owner typing
// ACTIVE, pressing Pull, and being told "1 updated" while nothing changes is the
// worst kind of no-op: it looks like it worked. This pass fixes it AFTER the
// import engine returns, entirely inside this module - shop's own CSV UI keeps
// its current behaviour, which is not ours to change quietly.

const VALID: ReadonlySet<string> = new Set<ShpProductStatus>(['DRAFT', 'ACTIVE', 'ARCHIVED'])

export async function applyStatusPass(grid: string[][]): Promise<{ updated: number; errors: SyncRowError[] }> {
  const errors: SyncRowError[] = []
  let updated = 0

  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const skuCol = header.indexOf('sku')
  const nameCol = header.indexOf('name')
  const statusCol = header.indexOf('status')
  if (statusCol < 0 || (skuCol < 0 && nameCol < 0)) return { updated, errors }

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? []
    const rawStatus = (row[statusCol] ?? '').trim()
    if (!rawStatus) continue
    const rowNumber = r + 1
    const status = rawStatus.toUpperCase()
    if (!VALID.has(status)) {
      errors.push({ row: rowNumber, reason: `Invalid status "${rawStatus}" (expected Draft, Active, or Archived)` })
      continue
    }
    // Same identity rule the import engine uses: SKU when the row has one, else
    // the slug derived from the name. Matching on SKU alone quietly did nothing
    // on a catalogue whose products carry no SKU - which is most of them, since
    // shop only ever sets a SKU if the owner types one.
    const sku = skuCol >= 0 ? (row[skuCol] ?? '').trim() : ''
    const name = nameCol >= 0 ? (row[nameCol] ?? '').trim() : ''
    if (!sku && !name) continue // matched by nothing; the import engine could not create/update it either

    // Read-only cross-module lookup. A row the engine skipped or errored has no
    // product here -> silent no-op, because the engine already logged its own
    // error for that row.
    const rows = sku
      ? await prisma.$queryRaw<{ id: string; status: string }[]>`
          SELECT "id", "status" FROM "shp_products" WHERE "sku" = ${sku} LIMIT 1
        `
      : await prisma.$queryRaw<{ id: string; status: string }[]>`
          SELECT "id", "status" FROM "shp_products" WHERE "slug" = ${slugify(name)} LIMIT 1
        `
    const product = rows[0]
    if (!product) continue
    if (product.status !== status) {
      await updateProduct(product.id, { status: status as ShpProductStatus })
      updated++
    }
  }

  return { updated, errors }
}
