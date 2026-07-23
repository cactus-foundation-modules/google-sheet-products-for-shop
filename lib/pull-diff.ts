import { CSV_COLUMNS, type CsvColumn } from '@/modules/shop/lib/csv'
import { buildProductCsvRows, type ProductCsvRow } from '@/modules/shop/lib/csv-rows'
import { slugify } from '@/modules/shop/lib/slug'
import { getProductsBySlugs } from '@/modules/shop/lib/db/products'
import { getEditorPayloadsBatch, type VariantEditorRow } from '@/modules/shop-variations/lib/variants-service'
import { parseVariantImages } from '@/modules/shop-variations/lib/csv'
import { resolveVariantFieldProviders } from '@/modules/shop-variations/lib/variant-field-providers'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// Row-level diff of the sheet against the shop, shared by the Pull preview (what
// the confirm dialog lists) and the Pull itself (which rows actually get fed to
// the importers). One diff, two consumers - the dialog can never promise a
// different Pull than the one that runs.
//
// The point of the exercise: a Pull used to push EVERY row through the import
// engines, and a row that changes nothing still costs the same DB round trips as
// one that changes everything. On a big catalogue where the owner edited two
// cells, that made "pull two cells" take minutes. Rows this diff proves unchanged
// are dropped before the importers ever see them.
//
// Being wrong in the "unchanged" direction quietly loses an edit, so every
// comparison here is conservative: anything we cannot positively prove equal
// counts as changed and goes through the importer, which is merely slower, never
// wrong.

export type Change = { field: string; from: string; to: string }

export type ProductRowResult =
  | { row: number; kind: 'error'; reason: string }
  | { row: number; kind: 'create'; sku: string | null; name: string }
  | { row: number; kind: 'update'; sku: string | null; name: string; changes: Change[] }
  | { row: number; kind: 'unchanged'; sku: string | null; name: string }

export type VariationRowResult = { row: number; kind: 'create' | 'update' | 'unchanged' | 'error'; reason?: string }

const VALID_STATUS = new Set(['DRAFT', 'ACTIVE', 'ARCHIVED'])
const VALID_TYPE = new Set(['PHYSICAL', 'DIGITAL', 'SERVICE'])

// Columns whose stored value is an enum or boolean the importer reads
// case-insensitively, so "active" in the sheet equals ACTIVE in the shop.
const CASE_INSENSITIVE_COLUMNS: ReadonlySet<CsvColumn> = new Set<CsvColumn>([
  'type', 'status', 'track_inventory', 'is_pre_order', 'out_of_stock_behaviour', 'related_mode', 'upsell_mode',
])

// Same numeric-tolerant equality the eye would use: "9.9" and "9.90" are equal
// (Sheets strips trailing zeros off numeric cells), but two non-numbers compare
// as trimmed strings.
function sameValue(a: string, b: string): boolean {
  const ta = a.trim()
  const tb = b.trim()
  if (ta !== '' && tb !== '') {
    const na = Number(ta)
    const nb = Number(tb)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  }
  return ta === tb
}

function normHeader(grid: string[][]): string[] {
  return (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
}

// Diff every Products row against what a Push would write for the matching
// product - the exact same row builder, column for column. A column absent from
// the sheet is not part of the sync and is never compared (the importer leaves
// its field alone too). `results[i].row` is the grid row index (1-based data
// rows start at 1), so callers can filter the grid by it.
export async function diffProductRows(productsGrid: string[][]): Promise<ProductRowResult[]> {
  const header = normHeader(productsGrid)
  // Only diff header columns that are ours; an owner's own extra columns are
  // invisible to the importer, so they must be invisible here too.
  const compared: Array<{ col: CsvColumn; idx: number }> = []
  for (const col of CSV_COLUMNS) {
    const idx = header.indexOf(col)
    if (idx >= 0) compared.push({ col, idx })
  }

  const csvRows = await buildProductCsvRows()
  const bySku = new Map<string, ProductCsvRow>()
  const bySlug = new Map<string, ProductCsvRow>()
  for (const r of csvRows) {
    if (r.sku) bySku.set(r.sku, r)
    bySlug.set(r.slug, r)
  }

  const nameCol = header.indexOf('name')
  const typeCol = header.indexOf('type')
  const priceCol = header.indexOf('price')
  const statusCol = header.indexOf('status')
  const skuCol = header.indexOf('sku')
  const slugCol = header.indexOf('slug')

  const results: ProductRowResult[] = []
  for (let r = 1; r < productsGrid.length; r++) {
    const row = productsGrid[r] ?? []
    const at = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
    const name = at(nameCol)
    const type = at(typeCol).toUpperCase()
    const priceRaw = at(priceCol)
    const statusRaw = at(statusCol)
    const sku = at(skuCol) || null

    if (!name) { results.push({ row: r, kind: 'error', reason: 'Missing name' }); continue }
    if (!VALID_TYPE.has(type)) { results.push({ row: r, kind: 'error', reason: `Invalid type "${at(typeCol)}"` }); continue }
    if (!priceRaw || Number.isNaN(Number(priceRaw)) || Number(priceRaw) < 0) { results.push({ row: r, kind: 'error', reason: 'Missing or invalid price' }); continue }
    if (statusRaw && !VALID_STATUS.has(statusRaw.toUpperCase())) { results.push({ row: r, kind: 'error', reason: `Invalid status "${statusRaw}"` }); continue }

    // Same identity the import engine uses: SKU when the row carries one, else
    // the row's own slug (or the slug its name would derive).
    const rowSlug = slugify(at(slugCol) || name)
    const existing = sku ? bySku.get(sku) : bySlug.get(rowSlug)
    if (!existing) { results.push({ row: r, kind: 'create', sku, name }); continue }

    const changes: Change[] = []
    for (const { col, idx } of compared) {
      const to = (row[idx] ?? '').trim()
      const from = existing[col]
      const equal = CASE_INSENSITIVE_COLUMNS.has(col)
        ? from.trim().toUpperCase() === to.toUpperCase()
        : sameValue(from, to)
      if (!equal) changes.push({ field: col, from, to })
    }
    results.push(changes.length > 0
      ? { row: r, kind: 'update', sku, name, changes }
      : { row: r, kind: 'unchanged', sku, name })
  }
  return results
}

// Blank/non-numeric -> undefined, exactly as the importer's num() treats a cell.
function numCell(s: string): number | undefined {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

// Would the importer actually write anything for this row? Mirrors the changed
// check in upsertVariantForCombination plus its image compare, field for field.
function variationRowChanged(
  v: VariantEditorRow,
  cols: string[],
  col: { sku: number; price: number; salePrice: number; rrp: number; tradePrice: number; costPrice: number; stock: number; barcode: number; supplier: number; weight: number; image: number },
): boolean {
  const cell = (i: number) => (cols[i] ?? '').trim()
  if (col.price >= 0) {
    const price = numCell(cell(col.price))
    if (price !== undefined && v.price !== price) return true
  }
  // The optional price types: a blank cell means "cleared" (null), matching the
  // importer, so an unset figure left blank in the sheet reads as unchanged.
  const priceCellChanged = (colIndex: number, current: number | null): boolean => {
    if (colIndex < 0) return false
    const raw = cell(colIndex)
    const next = raw === '' ? null : numCell(raw) ?? null
    return next !== current
  }
  if (priceCellChanged(col.salePrice, v.salePrice)) return true
  if (priceCellChanged(col.rrp, v.retailPrice)) return true
  if (priceCellChanged(col.tradePrice, v.tradePrice)) return true
  if (priceCellChanged(col.costPrice, v.costPrice)) return true
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

// Diff every Variations row: create / update / unchanged / error, per grid row.
// Same resolution the importer uses (parent by slug, variant by its unordered
// option-value set), with module-provided columns (3D files, attributes) diffed
// through each provider's read-only rowChanged. A provider without rowChanged
// cannot be diffed, so its rows are never called unchanged - see below.
export async function diffVariationRows(grid: string[][]): Promise<VariationRowResult[]> {
  const results: VariationRowResult[] = []
  if (grid.length < 2) return results

  const header = (grid[0] ?? []).map((h) => h.trim())
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const slugCol = idx('Parent Slug')
  if (slugCol < 0) {
    results.push({ row: 0, kind: 'error', reason: 'Missing "Parent Slug" column' })
    return results
  }
  const optionPairs: Array<{ nameCol: number; valueCol: number }> = []
  for (let i = 1; ; i++) {
    const nameCol = idx(`Option ${i}`)
    const valueCol = idx(`Value ${i}`)
    if (nameCol < 0 || valueCol < 0) break
    optionPairs.push({ nameCol, valueCol })
  }
  const fieldCol = {
    sku: idx('Variant SKU'), price: idx('Price'),
    salePrice: idx('Sale Price'), rrp: idx('RRP'), tradePrice: idx('Trade Price'), costPrice: idx('Cost Price'),
    stock: idx('Stock'),
    barcode: idx('Barcode'), supplier: idx('Supplier'), weight: idx('Weight'), image: idx('Image'),
  }

  const allProviders = await resolveVariantFieldProviders()
  const providers = allProviders.filter((p) => typeof p.provider.rowChanged === 'function')
  // A provider that owns columns but cannot say whether a row would change them
  // makes "unchanged" unprovable for every row - so nothing may be skipped, and
  // every matched row counts as an update. Slower, never wrong.
  const undiffableProviders = allProviders.length > providers.length

  const groups = new Map<string, Array<{ row: number; cols: string[] }>>()
  for (let r = 1; r < grid.length; r++) {
    const cols = grid[r] ?? []
    const slug = (cols[slugCol] ?? '').trim()
    if (!slug) {
      results.push({ row: r, kind: 'error', reason: 'Missing parent slug' })
      continue
    }
    const list = groups.get(slug) ?? []
    list.push({ row: r, cols })
    groups.set(slug, list)
  }

  // Both the parent lookup and each parent's editor payload are resolved once for
  // every distinct slug in the sheet, rather than per group.
  const parentBySlug = await getProductsBySlugs([...groups.keys()])
  const payloadByParentId = await getEditorPayloadsBatch([...parentBySlug.values()])

  for (const [slug, rows] of groups) {
    const parent = parentBySlug.get(slug)
    if (!parent) {
      for (const gr of rows) results.push({ row: gr.row, kind: 'error', reason: `Parent product not found: ${slug}` })
      continue
    }
    const payload = payloadByParentId.get(parent.id)
    const valueIdByKey = new Map<string, string>()
    for (const o of payload?.options ?? []) for (const v of o.values) valueIdByKey.set(`${o.name.toLowerCase()}|${v.label.toLowerCase()}`, v.id)
    const variantByKey = new Map((payload?.variants ?? []).map((v) => [[...v.optionValueIds].sort().join('|'), v]))

    // Preload each provider's current state for this parent's existing children,
    // exactly as the importer does, so rowChanged diffs in memory rather than
    // per row.
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
      if (!allResolvable) { results.push({ row: gr.row, kind: 'create' }); continue }
      if (ids.length === 0) { results.push({ row: gr.row, kind: 'error', reason: 'No options on this row' }); continue }
      const existing = variantByKey.get([...ids].sort().join('|'))
      if (!existing) { results.push({ row: gr.row, kind: 'create' }); continue }
      if (variationRowChanged(existing, gr.cols, fieldCol)) { results.push({ row: gr.row, kind: 'update' }); continue }
      if (undiffableProviders || (providers.length > 0 && await providerRowChanged(providers, parent.id, existing.childProductId, header, gr.cols, providerCtx))) {
        results.push({ row: gr.row, kind: 'update' })
        continue
      }
      results.push({ row: gr.row, kind: 'unchanged' })
    }
  }

  return results
}

// Header + every row the diff did NOT prove unchanged, in sheet order. What the
// Pull stores and feeds to the importers: creates, updates and error rows all go
// through (the importer reports its own row errors, exactly as before); rows
// that match the shop cell-for-cell are the only thing dropped.
export function filterGridByDiff(grid: string[][], results: Array<{ row: number; kind: string }>): string[][] {
  const keep = new Set(results.filter((r) => r.kind !== 'unchanged').map((r) => r.row))
  const out: string[][] = [grid[0] ?? []]
  for (let r = 1; r < grid.length; r++) if (keep.has(r)) out.push(grid[r] ?? [])
  return out
}
