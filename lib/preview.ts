import { prisma } from '@/lib/db/prisma'
import { listProducts } from '@/modules/shop/lib/db'
import { getProductBySlug } from '@/modules/shop/lib/db/products'
import { collectPaged, missingFormatColumns } from '@/modules/shop/lib/csv'
import { getEditorPayload } from '@/modules/shop-variations/lib/variants-service'
import type { ShpProduct } from '@/modules/shop/lib/types'
import type { GspConnection, PullPreview, SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

const VALID_STATUS = new Set(['DRAFT', 'ACTIVE', 'ARCHIVED'])
const VALID_TYPE = new Set(['PHYSICAL', 'DIGITAL', 'SERVICE'])

function normHeader(grid: string[][]): string[] {
  return (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
}

// Same numeric-tolerant equality the eye would use: "9.9" and "9.90" are equal,
// but two non-numbers compare as trimmed strings.
function sameValue(a: string, b: string): boolean {
  const na = Number(a)
  const nb = Number(b)
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  return a.trim() === b.trim()
}

function computeChanges(existing: ShpProduct, row: string[], header: string[]): Array<{ field: string; from: string; to: string }> {
  const changes: Array<{ field: string; from: string; to: string }> = []
  const cell = (name: string): string | null => {
    const i = header.indexOf(name)
    return i >= 0 ? (row[i] ?? '').trim() : null
  }
  const check = (field: string, sheetName: string, current: string, upper = false) => {
    const raw = cell(sheetName)
    if (raw == null) return // column absent -> not part of this sync
    const to = upper ? raw.toUpperCase() : raw
    const from = upper ? current.toUpperCase() : current
    if (!sameValue(from, to)) changes.push({ field, from: current, to: raw })
  }
  check('name', 'name', existing.name)
  check('type', 'type', existing.type, true)
  check('status', 'status', existing.status, true)
  check('price', 'price', existing.price)
  check('compare_at_price', 'compare_at_price', existing.compareAtPrice ?? '')
  check('cost_price', 'cost_price', existing.costPrice ?? '')
  check('stock_count', 'stock_count', existing.stockCount != null ? String(existing.stockCount) : '')
  check('barcode', 'barcode', existing.barcode ?? '')
  return changes
}

async function predictVariations(grid: string[][]): Promise<{ toCreate: number; toUpdate: number; rowErrors: SyncRowError[] }> {
  const rowErrors: SyncRowError[] = []
  let toCreate = 0
  let toUpdate = 0
  if (grid.length < 2) return { toCreate, toUpdate, rowErrors }

  const header = (grid[0] ?? []).map((h) => h.trim())
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const slugCol = idx('Parent Slug')
  if (slugCol < 0) {
    rowErrors.push({ row: 1, reason: 'Missing "Parent Slug" column' })
    return { toCreate, toUpdate, rowErrors }
  }
  const optionPairs: Array<{ nameCol: number; valueCol: number }> = []
  for (let i = 1; ; i++) {
    const nameCol = idx(`Option ${i}`)
    const valueCol = idx(`Value ${i}`)
    if (nameCol < 0 || valueCol < 0) break
    optionPairs.push({ nameCol, valueCol })
  }

  const groups = new Map<string, Array<{ rowNum: number; cols: string[] }>>()
  for (let r = 1; r < grid.length; r++) {
    const cols = grid[r] ?? []
    const slug = (cols[slugCol] ?? '').trim()
    if (!slug) {
      rowErrors.push({ row: r + 1, reason: 'Missing parent slug' })
      continue
    }
    const list = groups.get(slug) ?? []
    list.push({ rowNum: r + 1, cols })
    groups.set(slug, list)
  }

  for (const [slug, rows] of groups) {
    const parent = await getProductBySlug(slug)
    if (!parent || parent.catalogueHidden) {
      for (const gr of rows) rowErrors.push({ row: gr.rowNum, reason: `Parent product not found: ${slug}` })
      continue
    }
    const payload = await getEditorPayload(parent.id)
    const valueIdByKey = new Map<string, string>()
    for (const o of payload?.options ?? []) for (const v of o.values) valueIdByKey.set(`${o.name.toLowerCase()}|${v.label.toLowerCase()}`, v.id)
    const existingSets = new Set((payload?.variants ?? []).map((v) => [...v.optionValueIds].sort().join('|')))

    for (const gr of rows) {
      const ids: string[] = []
      let allResolvable = true
      for (const pair of optionPairs) {
        const optName = (gr.cols[pair.nameCol] ?? '').trim()
        const valLabel = (gr.cols[pair.valueCol] ?? '').trim()
        if (!optName || !valLabel) continue
        const id = valueIdByKey.get(`${optName.toLowerCase()}|${valLabel.toLowerCase()}`)
        if (!id) { allResolvable = false; break } // a new option/value = a new combination
        ids.push(id)
      }
      if (!allResolvable) { toCreate++; continue }
      if (ids.length === 0) { rowErrors.push({ row: gr.rowNum, reason: 'No options on this row' }); continue }
      if (existingSets.has([...ids].sort().join('|'))) toUpdate++
      else toCreate++
    }
  }

  return { toCreate, toUpdate, rowErrors }
}

// The whole Pull, dry-run. Writes nothing.
export async function buildPullPreview(productsGrid: string[][], variationsGrid: string[][], conn: GspConnection): Promise<PullPreview> {
  const headerMissing = missingFormatColumns(productsGrid[0] ?? [])

  const header = normHeader(productsGrid)
  const nameCol = header.indexOf('name')
  const typeCol = header.indexOf('type')
  const priceCol = header.indexOf('price')
  const statusCol = header.indexOf('status')
  const skuCol = header.indexOf('sku')

  const all = await collectPaged<ShpProduct>(async (page) => {
    const { products, total } = await listProducts({ page, perPage: 100, excludeHidden: true })
    return { items: products, total }
  })
  const bySku = new Map(all.filter((p) => p.sku).map((p) => [p.sku as string, p]))
  const sheetSkus = new Set<string>()

  const toCreate: PullPreview['products']['toCreate'] = []
  const toUpdate: PullPreview['products']['toUpdate'] = []
  const rowErrors: SyncRowError[] = []

  // Only try to diff rows once the header is intact - column indices below are
  // meaningless otherwise, and the caller surfaces headerMissing regardless.
  if (headerMissing.length === 0) {
    for (let r = 1; r < productsGrid.length; r++) {
      const row = productsGrid[r] ?? []
      const rowNumber = r + 1
      const at = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
      const name = at(nameCol)
      const type = at(typeCol).toUpperCase()
      const priceRaw = at(priceCol)
      const statusRaw = at(statusCol)
      const sku = at(skuCol) || null
      if (sku) sheetSkus.add(sku)

      if (!name) { rowErrors.push({ row: rowNumber, reason: 'Missing name' }); continue }
      if (!VALID_TYPE.has(type)) { rowErrors.push({ row: rowNumber, reason: `Invalid type "${at(typeCol)}"` }); continue }
      if (!priceRaw || Number.isNaN(Number(priceRaw))) { rowErrors.push({ row: rowNumber, reason: 'Missing or invalid price' }); continue }
      if (statusRaw && !VALID_STATUS.has(statusRaw.toUpperCase())) { rowErrors.push({ row: rowNumber, reason: `Invalid status "${statusRaw}"` }); continue }

      const existing = sku ? bySku.get(sku) : undefined
      if (existing) toUpdate.push({ sku, name, changes: computeChanges(existing, row, header) })
      else toCreate.push({ sku, name })
    }
  }

  const missingFromSheet = all
    .filter((p) => p.sku && !sheetSkus.has(p.sku) && p.status !== 'ARCHIVED')
    .map((p) => ({ id: p.id, sku: p.sku as string, name: p.name, status: p.status }))

  let staleness: PullPreview['staleness'] = { changedSinceLastPush: 0, since: null }
  if (conn.lastPushAt) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "shp_products"
      WHERE "catalogue_hidden" = false AND "updated_at" > ${conn.lastPushAt}
    `
    staleness = { changedSinceLastPush: Number(rows[0]?.count ?? 0), since: conn.lastPushAt.toISOString() }
  }

  const variations = await predictVariations(variationsGrid)

  return { products: { toCreate, toUpdate, missingFromSheet, rowErrors }, variations, staleness, headerMissing }
}
