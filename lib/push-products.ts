import { CSV_COLUMNS, NUMERIC_CSV_COLUMNS, BOOLEAN_CSV_COLUMNS, type CsvColumn } from '@/modules/shop/lib/csv'
import { buildProductCsvRows } from '@/modules/shop/lib/csv-rows'
import { getProductsBySlugs } from '@/modules/shop/lib/db/products'
import { resolveProductFieldProviders } from '@/modules/shop/lib/product-field-providers'
import { type CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { coerceOpenCell } from '@/modules/google-sheet-products-for-shop/lib/numeric-cell'
import { pushGrid } from '@/modules/google-sheet-products-for-shop/lib/push-grid'
import { DESCRIPTION_PUCK_COLUMN, descriptionPuckCell } from '@/modules/google-sheet-products-for-shop/lib/description-puck'
import { VARIATIONS_COLUMN, getVariationCounts } from '@/modules/google-sheet-products-for-shop/lib/variation-count'
import { TAB, applyProductsValidation } from '@/modules/google-sheet-products-for-shop/lib/workbook'
import { DEFAULT_COLUMN_PREFS, excludedProductColumns, type ColumnPrefs } from '@/modules/google-sheet-products-for-shop/lib/columns'

// The Products header. Cost price is always included - the owner asked for it to
// go every time rather than sit behind an on/off setting. It is a reference
// figure like RRP and trade, and anyone the sheet is shared with can see it.
//
// Stock count and trade price DO sit behind a setting (see lib/columns.ts); a
// switched-off column simply never reaches the grid, and the Push clears the one
// the sheet still has left over from last time.
export function productColumns(prefs: ColumnPrefs = DEFAULT_COLUMN_PREFS): CsvColumn[] {
  const excluded = new Set<string>(excludedProductColumns(prefs))
  return CSV_COLUMNS.filter((c) => !excluded.has(c))
}

// A header as the Pull normalises it (lowercased, spaces to underscores), so a
// provider field labelled "Variations" is recognised as a clash with our own
// column rather than sailing past a case-sensitive compare.
function normaliseHeader(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '_')
}

// How many products are asked for their contributed columns at once. The
// connection pool is shared with everything else the admin is doing, so this
// stays modest; it is still the difference between a few seconds and a few
// hundred round trips taken strictly one after the other.
const PRODUCT_COLUMN_CONCURRENCY = 8

// Cells go into the sheet as the type they actually are. Writing a price as the
// string "100" makes a text cell, which Sheets shows as '100 and refuses to sum,
// sort or chart - so numeric and boolean columns are converted, and everything
// else (sku and barcode included, since those may carry leading zeros) stays text.
function typedCell(column: CsvColumn, value: string): CellValue {
  if (value === '') return ''
  if (NUMERIC_CSV_COLUMNS.includes(column)) {
    const n = Number(value)
    // isFinite, not !isNaN: Infinity/-Infinity are not NaN but serialise to JSON
    // null, which values.update reads as "leave the existing cell", silently
    // keeping a stale sheet value. Fall back to the raw text instead.
    return Number.isFinite(n) ? n : value
  }
  if (BOOLEAN_CSV_COLUMNS.includes(column)) {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === 'false') return lower === 'true'
  }
  return value
}

// Build the Products grid: header row + one row per (non-hidden) product, from
// the same row builder the shop's CSV export uses - one format, one source, so
// the sheet cannot quietly fall behind the CSV again. We assemble the grid
// directly rather than round-tripping through CSV text: the write is RAW, so
// shop's formula-injection guard (which prefixes a leading apostrophe) is both
// redundant and would show the owner a stray ' in their cells.
export async function buildProductsGrid(prefs: ColumnPrefs = DEFAULT_COLUMN_PREFS): Promise<CellValue[][]> {
  const rows = await buildProductCsvRows()
  const columns = productColumns(prefs)

  // Product-level attribute columns (and any other module's product fields),
  // appended after the fixed columns - the Products-tab twin of the extra-field
  // columns the Variations tab carries. Each provider contributes a set that
  // varies per product, so the header is the union of every column label seen, in
  // first-seen order, and a product without a given column leaves its cell blank.
  const providers = await resolveProductFieldProviders()
  const bySlug = await getProductsBySlugs(rows.map((r) => r.slug))
  const idBySlug = new Map(rows.map((r) => [r.slug, bySlug.get(r.slug)?.id]).filter((e): e is [string, string] => !!e[1]))
  const productIds = [...new Set(idBySlug.values())]

  const fieldHeaderOrder: string[] = []
  const colsByProduct = new Map<string, Array<{ key: string; label: string }>>()
  const valuesByProduct = new Map<string, Record<string, string>>()
  if (providers.length > 0 && productIds.length > 0) {
    // Which columns a product contributes is one database round trip per product
    // per provider, and the answers do not depend on one another - so they are
    // asked in batches rather than one product after another. Strictly serial,
    // this single loop was the slowest thing in a Push on a real catalogue: a few
    // hundred products at a round trip each, before a cell had been written.
    // Batched, the whole pass is a few seconds. The results are still folded in
    // catalogue order below, so the header's first-seen column order is unchanged.
    const columnsById = new Map<string, Array<Array<{ key: string; label: string }>>>()
    for (let i = 0; i < productIds.length; i += PRODUCT_COLUMN_CONCURRENCY) {
      const batch = productIds.slice(i, i + PRODUCT_COLUMN_CONCURRENCY)
      const answers = await Promise.all(batch.map(async (productId) =>
        Promise.all(providers.map(({ provider }) => provider.listColumns(productId))),
      ))
      batch.forEach((productId, j) => columnsById.set(productId, answers[j] ?? []))
    }

    for (const productId of productIds) {
      const cols: Array<{ key: string; label: string }> = []
      for (const perProvider of columnsById.get(productId) ?? []) {
        for (const c of perProvider) {
          // Two providers (or two keys) can present the same visible label. A
          // sheet column is addressed by its label on the way back in (Pull hands
          // providers a row keyed by header text), so two same-labelled columns
          // cannot round-trip - the second would read the first's value. We
          // therefore merge deterministically on first-seen label (provider order
          // is stable) and warn, rather than silently emit an ambiguous column.
          if (cols.some((existing) => existing.label === c.label && existing.key !== c.key)) {
            console.warn(`[google-sheet-products-for-shop] duplicate product-field label "${c.label}" - keeping the first; give the fields distinct labels to sync both.`)
            continue
          }
          // Same reasoning against this module's own columns: a field labelled
          // "Variations" would land a second column under the same header (Pull
          // reads a column by its header text), so ours wins and the field is
          // skipped with a warning rather than emitting an ambiguous pair.
          if (normaliseHeader(c.label) === VARIATIONS_COLUMN) {
            console.warn(`[google-sheet-products-for-shop] product-field label "${c.label}" clashes with the built-in ${VARIATIONS_COLUMN} column - rename the field to sync it.`)
            continue
          }
          cols.push({ key: c.key, label: c.label })
          if (!fieldHeaderOrder.includes(c.label)) fieldHeaderOrder.push(c.label)
        }
      }
      colsByProduct.set(productId, cols)
    }
    // getValues takes the whole product list at once, so the providers only need
    // to be asked alongside one another rather than in turn.
    const valueSets = await Promise.all(providers.map(({ provider }) => provider.getValues(productIds)))
    for (const got of valueSets) {
      for (const [productId, rec] of Object.entries(got)) {
        valuesByProduct.set(productId, { ...(valuesByProduct.get(productId) ?? {}), ...rec })
      }
    }
  }

  // How many variations each product has - one grouped query for the whole
  // catalogue, not one per row.
  const variationCounts = await getVariationCounts(productIds)

  // The designed description and the variation count sit between the fixed
  // columns and the open-ended provider tail: columns this module owns outright,
  // so they keep a fixed position rather than being shuffled about with the
  // attribute columns.
  const header: CellValue[] = [...columns.map((c) => c as CellValue), DESCRIPTION_PUCK_COLUMN, VARIATIONS_COLUMN, ...fieldHeaderOrder]
  const grid: CellValue[][] = [header]
  for (const row of rows) {
    const base = columns.map((c) => typedCell(c, row[c] ?? ''))
    const designed = descriptionPuckCell(bySlug.get(row.slug)?.descriptionPuck ?? null)
    const productId = idBySlug.get(row.slug)
    // A real number, not the string "3", so the column sorts and sums like one.
    // A product with no variations gets a plain 0 rather than a blank: blank
    // would read as "we do not know", and 0 is the honest answer.
    const variations: CellValue = productId ? variationCounts.get(productId) ?? 0 : 0
    const cols = productId ? colsByProduct.get(productId) ?? [] : []
    const values = productId ? valuesByProduct.get(productId) ?? {} : {}
    // Attribute/extra-field columns have no fixed type: a numeric one must go in
    // as a real number, not the string "100" (which Sheets stores as a text cell,
    // shows as '100, and which defeats formula preservation). coerceOpenCell keeps
    // a genuine code like "0100" as text - see numeric-cell.ts.
    const fieldCells: CellValue[] = fieldHeaderOrder.map((label) => {
      const col = cols.find((c) => c.label === label)
      return coerceOpenCell(col ? values[col.key] ?? '' : '')
    })
    grid.push([...base, designed, variations, ...fieldCells])
  }
  return grid
}

// A product row is identified by SKU, falling back to slug when it has none -
// the same order Pull matches a sheet row to a product in, so the two directions
// agree on what "the same row" means.
const PRODUCT_KEYS = [['sku'], ['slug']]

// The Products header is a closed set, so a column beyond the pushed grid can be
// told apart from one the owner added themselves with certainty. The designed
// description and the variation count are ours too, even though neither is one of
// shop's CSV columns - leave one out and a Push would treat it as the owner's own
// column, shove it rightwards to make room and then never clear it.
const PRODUCT_COLUMN_NAMES: ReadonlySet<string> = new Set<string>([...CSV_COLUMNS, DESCRIPTION_PUCK_COLUMN, VARIATIONS_COLUMN])

// Write an already-built Products grid to the Products tab. Split out from
// buildProductsGrid so a resumable Push can snapshot the grid once at start (for a
// stable, deterministic re-run) and write it in the PRODUCTS step. Returns the
// number of product rows written (excl. header) and how many owner formulas
// survived.
export async function pushProductsGrid(
  spreadsheetId: string,
  grid: CellValue[][],
): Promise<{ rowCount: number; preservedFormulas: number }> {
  const result = await pushGrid({
    spreadsheetId,
    tab: TAB.PRODUCTS,
    grid,
    keyStrategies: PRODUCT_KEYS,
    ownsColumn: (header) => PRODUCT_COLUMN_NAMES.has(header),
  })
  // Dropdowns for type/status/out_of_stock_behaviour and the recommendation
  // modes, positioned against the header the Push actually wrote - the sheet's
  // own column order, which is not necessarily the export's.
  await applyProductsValidation(spreadsheetId, result.header)
  return result
}
