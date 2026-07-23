import { prisma } from '@/lib/db/prisma'
import { listProducts } from '@/modules/shop/lib/db'
import { getProductsBySlugs } from '@/modules/shop/lib/db/products'
import { collectPaged, missingFormatColumns } from '@/modules/shop/lib/csv'
import { slugify } from '@/modules/shop/lib/slug'
import { getEditorPayloadsBatch, type VariantEditorRow } from '@/modules/shop-variations/lib/variants-service'
import { parseVariantImages } from '@/modules/shop-variations/lib/csv'
import { resolveVariantFieldProviders } from '@/modules/shop-variations/lib/variant-field-providers'
import { planPullDeletions } from '@/modules/google-sheet-products-for-shop/lib/deletions'
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
  const str = (v: string | number | boolean | null | undefined) => (v == null ? '' : String(v))
  check('name', 'name', existing.name)
  check('slug', 'slug', existing.slug)
  check('type', 'type', existing.type, true)
  check('status', 'status', existing.status, true)
  check('price', 'price', existing.price)
  check('sale_price', 'sale_price', existing.salePrice ?? '')
  check('retail_price', 'retail_price', existing.retailPrice ?? '')
  check('trade_price', 'trade_price', existing.tradePrice ?? '')
  check('cost_price', 'cost_price', existing.costPrice ?? '')
  check('stock_count', 'stock_count', str(existing.stockCount))
  check('barcode', 'barcode', existing.barcode ?? '')
  check('weight', 'weight', existing.weight ?? '')
  check('dimension_l', 'dimension_l', str(existing.dimensionL))
  check('dimension_w', 'dimension_w', str(existing.dimensionW))
  check('dimension_h', 'dimension_h', str(existing.dimensionH))
  check('dimension_unit', 'dimension_unit', existing.dimensionUnit ?? '')
  check('download_limit', 'download_limit', str(existing.downloadLimit))
  check('download_expiry', 'download_expiry', str(existing.downloadExpiry))
  check('is_pre_order', 'is_pre_order', String(existing.isPreOrder), true)
  check('pre_order_dispatch_date', 'pre_order_dispatch_date', existing.preOrderDispatchDate ? existing.preOrderDispatchDate.toISOString().slice(0, 10) : '')
  check('pre_order_note', 'pre_order_note', existing.preOrderNote ?? '')
  check('pre_order_max_quantity', 'pre_order_max_quantity', str(existing.preOrderMaxQuantity))
  check('related_mode', 'related_mode', existing.relatedMode, true)
  check('related_limit', 'related_limit', str(existing.relatedLimit))
  check('upsell_mode', 'upsell_mode', existing.upsellMode, true)
  check('upsell_limit', 'upsell_limit', str(existing.upsellLimit))
  return changes
}

// Blank/non-numeric -> undefined, exactly as the importer's num() treats a cell.
function numCell(s: string): number | undefined {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

// Would the importer actually write anything for this row? Mirrors the changed
// check in upsertVariantForCombination plus its image compare, field for field -
// the preview's "to update" must mean "a value differs", not "the row exists".
// Counting every matched row (as this used to) made a Pull straight after a Push
// claim the whole catalogue needed updating when nothing had changed at all.
function variationRowChanged(
  v: VariantEditorRow,
  cols: string[],
  col: { sku: number; price: number; stock: number; barcode: number; supplier: number; weight: number; image: number },
): boolean {
  const cell = (i: number) => (cols[i] ?? '').trim()
  if (col.price >= 0) {
    const price = numCell(cell(col.price))
    if (price !== undefined && v.price !== price) return true
  }
  if (col.sku >= 0 && (v.sku ?? null) !== (cell(col.sku) || null)) return true
  if (col.barcode >= 0 && (v.barcode ?? null) !== (cell(col.barcode) || null)) return true
  if (col.supplier >= 0 && (v.supplier ?? null) !== (cell(col.supplier) || null)) return true
  if (col.stock >= 0 && (v.stockCount ?? null) !== (numCell(cell(col.stock)) ?? null)) return true
  if (col.weight >= 0 && (v.weight ?? null) !== (numCell(cell(col.weight)) ?? null)) return true
  if (col.image >= 0) {
    const urls = parseVariantImages(cell(col.image))
    if (urls.length !== v.imageUrls.length || urls.some((u, i) => u !== v.imageUrls[i])) return true
  }
  return false
}

// Would any provider column change for this row? Builds the same header-keyed row
// record the importer hands providers, then asks each provider's read-only
// rowChanged, stopping at the first that says yes.
async function providerRowChanged(
  providers: Awaited<ReturnType<typeof resolveVariantFieldProviders>>,
  parentId: string,
  childProductId: string,
  header: string[],
  cols: string[],
  providerCtx: Map<string, unknown>,
): Promise<boolean> {
  const rowRecord: Record<string, string> = {}
  header.forEach((h, i) => { rowRecord[h] = (cols[i] ?? '').trim() })
  for (const { id, provider } of providers) {
    if (await provider.rowChanged!(parentId, childProductId, rowRecord, providerCtx.get(id))) return true
  }
  return false
}

// Create/update counts only. Deletions (partial + emptied parents, with the
// push-baseline anchor) come from planPullDeletions, the same planner the Pull
// runs, so the preview's "to remove" count matches exactly what happens.
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
  const fieldCol = {
    sku: idx('Variant SKU'), price: idx('Price'), stock: idx('Stock'),
    barcode: idx('Barcode'), supplier: idx('Supplier'), weight: idx('Weight'), image: idx('Image'),
  }

  // Modules hang extra per-variant columns (3D files, attribute helpings) off the
  // sheet through this point. Their columns are diffed via each provider's
  // read-only rowChanged, so a Pull that would swap a 3D file or a variation
  // attribute is counted as an update here instead of being reported as "nothing
  // to update" and then quietly doing it on apply. A provider without rowChanged
  // (there were none before this existed) is simply not counted, as before.
  const providers = (await resolveVariantFieldProviders()).filter((p) => typeof p.provider.rowChanged === 'function')

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

  // Both the parent lookup and each parent's editor payload are resolved once for
  // every distinct slug in the sheet, rather than per group - a sheet naming
  // hundreds of parents used to fire that many round trips for each.
  const parentBySlug = await getProductsBySlugs([...groups.keys()])
  const payloadByParentId = await getEditorPayloadsBatch([...parentBySlug.values()])

  for (const [slug, rows] of groups) {
    const parent = parentBySlug.get(slug)
    if (!parent) {
      for (const gr of rows) rowErrors.push({ row: gr.rowNum, reason: `Parent product not found: ${slug}` })
      continue
    }
    const payload = payloadByParentId.get(parent.id)
    const valueIdByKey = new Map<string, string>()
    for (const o of payload?.options ?? []) for (const v of o.values) valueIdByKey.set(`${o.name.toLowerCase()}|${v.label.toLowerCase()}`, v.id)
    const variantByKey = new Map((payload?.variants ?? []).map((v) => [[...v.optionValueIds].sort().join('|'), v]))

    // Preload each provider's current state for this parent's existing children,
    // exactly as the importer does, so rowChanged diffs in memory rather than
    // per row. A child created mid-import is absent here and reads as empty.
    const providerCtx = new Map<string, unknown>()
    if (providers.length > 0) {
      const childIds = (payload?.variants ?? []).map((v) => v.childProductId)
      for (const { id, provider } of providers) {
        if (provider.beginImport) providerCtx.set(id, await provider.beginImport(parent.id, childIds))
      }
    }

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
      const existing = variantByKey.get([...ids].sort().join('|'))
      if (!existing) { toCreate++; continue }
      if (variationRowChanged(existing, gr.cols, fieldCol)) { toUpdate++; continue }
      // Built-in fields match. Ask each provider whether its own columns would
      // change - a differing 3D file or attribute cell still means "to update".
      if (providers.length > 0 && await providerRowChanged(providers, parent.id, existing.childProductId, header, gr.cols, providerCtx)) toUpdate++
      // else: the row matches what's stored - the Pull will touch nothing for it.
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
  const slugCol = header.indexOf('slug')

  const all = await collectPaged<ShpProduct>(async (page) => {
    const { products, total } = await listProducts({ page, perPage: 100, excludeHidden: true })
    return { items: products, total }
  })
  const bySku = new Map(all.filter((p) => p.sku).map((p) => [p.sku as string, p]))
  // Fallback identity for SKU-less products: their slug (derived from name on
  // creation). Mirrors the import engine, which now matches the same way - so the
  // preview's create/update split matches what the Pull actually does instead of
  // calling every SKU-less product "new".
  const bySlug = new Map(all.map((p) => [p.slug, p]))

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

      if (!name) { rowErrors.push({ row: rowNumber, reason: 'Missing name' }); continue }
      if (!VALID_TYPE.has(type)) { rowErrors.push({ row: rowNumber, reason: `Invalid type "${at(typeCol)}"` }); continue }
      if (!priceRaw || Number.isNaN(Number(priceRaw)) || Number(priceRaw) < 0) { rowErrors.push({ row: rowNumber, reason: 'Missing or invalid price' }); continue }
      if (statusRaw && !VALID_STATUS.has(statusRaw.toUpperCase())) { rowErrors.push({ row: rowNumber, reason: `Invalid status "${statusRaw}"` }); continue }

      // Same identity the import engine uses: the row's own slug when the sheet
      // carries one, else the slug derived from the name. Diverging here would
      // show the owner a create/update split the Pull then contradicts.
      const rowSlug = slugify(at(slugCol) || name)
      const existing = sku ? bySku.get(sku) : bySlug.get(rowSlug)
      if (existing) toUpdate.push({ sku, name, changes: computeChanges(existing, row, header) })
      else toCreate.push({ sku, name })
    }
  }

  // Deletions (products + variations) come from the shared planner so the preview
  // shows exactly what the Pull will remove - reusing `all` to save a refetch. A
  // mangled header means we can't read the sheet's identity columns, so we plan no
  // deletions (and the Pull itself refuses outright until the header is fixed).
  const plan = headerMissing.length === 0
    ? await planPullDeletions(productsGrid, variationsGrid, conn.lastPushAt, all)
    : { products: [], variations: [] }

  let staleness: PullPreview['staleness'] = { changedSinceLastPush: 0, since: null }
  if (conn.lastPushAt) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "shp_products"
      WHERE "catalogue_hidden" = false AND "updated_at" > ${conn.lastPushAt}
    `
    staleness = { changedSinceLastPush: Number(rows[0]?.count ?? 0), since: conn.lastPushAt.toISOString() }
  }

  const variationsPred = await predictVariations(variationsGrid)
  const variations = {
    toCreate: variationsPred.toCreate,
    toUpdate: variationsPred.toUpdate,
    toDelete: plan.variations.length,
    rowErrors: variationsPred.rowErrors,
  }

  return { products: { toCreate, toUpdate, toDelete: plan.products, rowErrors }, variations, staleness, headerMissing }
}
