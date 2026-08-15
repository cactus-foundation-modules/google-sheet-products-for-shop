import { PRICE_TYPE_COLUMNS } from '@/modules/shop-variations/lib/csv'
import type { CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// Per-product Variations tabs.
//
// The catalogue used to mirror into ONE "Variations" tab: every variant of every
// product, its option pairs widened to the widest product so a two-option product
// still carried five blank "Option/Value" columns because some other product had
// five. Now each variable product gets its OWN tab, showing only the option
// columns it actually uses.
//
// The whole Pull pipeline (diff, deletions, importer, chunking) still works off a
// single wide grid with the superset header - exactly the shape the old single
// tab produced. So Push SPLITS the wide grid the database builds into one narrow
// grid per product (this file), and Pull MERGES the per-product tabs back into
// that same wide grid (this file). Everything between the two is untouched.
//
// Split and merge are exact inverses on the columns that matter, which is what
// the round-trip test in variation-tabs.test.ts pins down.

// The columns this module and shop-variations own, in the order
// exportVariationsCsv writes them. Everything else in a header is either an
// option pair (matched by regex) or an open-ended extra field another module
// contributes - a label we cannot enumerate, kept in first-seen order.
const LEADING_COLUMNS = ['Parent Slug', 'Parent Name'] as const
const FIXED_MIDDLE_COLUMNS = [
  'Variant SKU', 'Sale SKU', 'Price', ...PRICE_TYPE_COLUMNS, 'Stock', 'Barcode', 'Supplier', 'Weight', 'Image', 'Variant ID',
] as const
const OPTION_PAIR = /^(Option|Value) \d+$/

// The fixed columns that are written even when every variant leaves them blank.
// Two of them identify a row (which is how a Pull knows which variant it is
// looking at) and the third is the price, whose absence is a fact worth seeing.
// Every OTHER fixed column is left off a product's tab when no variant of that
// product has a value in it: a chair with no sale price does not need a Sale
// Price column any more than it needs an option it does not use.
//
// Leaving one off does not take the field away. A Pull reads the columns it
// FINDS, by name - so typing the heading back in a spare column and filling it
// in is all it takes to set that field, and the next Push keeps the column now
// that something is in it. mergeVariationTabs already works this way for a
// column an owner deleted by hand; this simply stops us writing the blank one in
// the first place.
const ALWAYS_COLUMNS: ReadonlySet<string> = new Set(['Variant SKU', 'Variant ID', 'Price'])

const SLUG_HEADER = 'Parent Slug'
const NAME_HEADER = 'Parent Name'

// Reserved tab titles a variation tab can never be mistaken for. Kept in step
// with workbook.ts's TAB set plus the legacy Suppliers title.
export const RESERVED_TAB_TITLES: ReadonlySet<string> = new Set([
  'Products', 'Variations', 'Suppliers', 'Supplier Catalogues', 'Read me',
])

// Google caps a tab title at 100 chars and forbids these five. A title is also
// unique within a workbook, so duplicates get a disambiguating slug suffix.
const TAB_TITLE_FORBIDDEN = /[[\]:*?/\\]/g
const TAB_TITLE_MAX = 100

function trimTo(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trim() : value
}

// A product's tab title: its name, with the characters Google forbids stripped,
// truncated to fit, and made unique against the titles already taken (reserved
// titles and tabs assigned earlier in the same Push). A clash appends part of the
// slug; a still-clashing or empty result falls back to the slug alone. `taken` is
// mutated so a caller looping over products accumulates the assignments.
export function productTabTitle(name: string, slug: string, taken: Set<string>): string {
  const cleaned = trimTo((name || '').replace(TAB_TITLE_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim(), TAB_TITLE_MAX)
  const cleanSlug = trimTo((slug || '').replace(TAB_TITLE_FORBIDDEN, ' ').trim(), TAB_TITLE_MAX)
  const candidates = [
    cleaned,
    cleaned ? trimTo(`${cleaned} (${cleanSlug})`, TAB_TITLE_MAX) : '',
    cleanSlug,
  ]
  for (const c of candidates) {
    if (c && !taken.has(c) && !RESERVED_TAB_TITLES.has(c)) {
      taken.add(c)
      return c
    }
  }
  // Everything clashed (two products with the same name AND slug should be
  // impossible, but never hand back a duplicate title - Google would reject it).
  let i = 2
  const base = cleaned || cleanSlug || 'Variations'
  for (;;) {
    const c = trimTo(`${base} ${i}`, TAB_TITLE_MAX)
    if (!taken.has(c) && !RESERVED_TAB_TITLES.has(c)) { taken.add(c); return c }
    i++
  }
}

// A tab is a variation tab if its title is not reserved and its header carries
// "Parent Slug" - the same structural marker the old single tab had in A1. Used
// to pick the catalogue tabs out of a workbook that also holds Products,
// Suppliers, Read me and anything the owner added.
//
// The marker is looked for ACROSS the header, not just in A1: the owner is free
// to drag these columns into whatever order suits them (a Push writes their
// order back rather than the export's), and a tab whose Parent Slug had moved to
// column D would otherwise stop being recognised as a catalogue tab at all -
// which reads as "the tab has gone" and stops the Pull.
export function isVariationTab(title: string, header: readonly string[]): boolean {
  if (RESERVED_TAB_TITLES.has(title)) return false
  return header.some((h) => (h ?? '').trim() === SLUG_HEADER)
}

// Column layout of a wide/narrow variation header. Positions are looked up by
// name (and option pairs by index), so the exact column ORDER never matters to
// the pipeline - only that every needed column is present and each cell lands
// under the right header.
type HeaderLayout = {
  slug: number
  name: number
  // Highest option index present (1-based); 0 when the header carries no options.
  optionCount: number
  // header label -> column index, for a fixed-middle column that is present.
  fixed: Map<string, number>
  // Extra columns another module contributes, in header order: { label, index }.
  fields: Array<{ label: string; index: number }>
}

function readLayout(header: readonly string[]): HeaderLayout {
  const trimmed = header.map((h) => (h ?? '').trim())
  const fixed = new Map<string, number>()
  const fields: Array<{ label: string; index: number }> = []
  let optionCount = 0
  const fixedSet = new Set<string>(FIXED_MIDDLE_COLUMNS)
  trimmed.forEach((h, i) => {
    if (h === SLUG_HEADER || h === NAME_HEADER) return
    if (OPTION_PAIR.test(h)) {
      const n = Number(h.split(' ')[1])
      if (Number.isFinite(n) && n > optionCount) optionCount = n
      return
    }
    if (fixedSet.has(h)) { if (!fixed.has(h)) fixed.set(h, i); return }
    if (h !== '') fields.push({ label: h, index: i })
  })
  return {
    slug: trimmed.indexOf(SLUG_HEADER),
    name: trimmed.indexOf(NAME_HEADER),
    optionCount,
    fixed,
    fields,
  }
}

// The option pair columns for indices 1..count: Option 1, Value 1, Option 2, ...
function optionPairHeaders(count: number): string[] {
  const cols: string[] = []
  for (let i = 1; i <= count; i++) cols.push(`Option ${i}`, `Value ${i}`)
  return cols
}

export type ProductTab = { slug: string; name: string; grid: CellValue[][] }

// Wide export grid -> one narrow grid per product, in first-appearance order.
// Each product's grid keeps only the option pairs it actually uses (a contiguous
// prefix, since the export fills them from Option 1) and only the extra field
// columns it has a value in - everything else is dropped, so the tab shows just
// that product's attributes. The fixed columns are always present.
// `excludedColumns` names fixed columns the owner has switched off (see
// lib/columns.ts) - they are dropped from every tab, and the Push clears whatever
// the sheet still holds under them. Everything else is unaffected.
export function splitWideGridByProduct(wide: CellValue[][], excludedColumns: readonly string[] = []): ProductTab[] {
  const header = (wide[0] ?? []).map((c) => String(c))
  const layout = readLayout(header)
  if (layout.slug < 0) return []
  const dataRows = wide.slice(1)
  const dropped = new Set(excludedColumns)
  const fixedColumns = FIXED_MIDDLE_COLUMNS.filter((c) => !dropped.has(c))

  // Group rows by slug, first-seen order.
  const order: string[] = []
  const bySlug = new Map<string, CellValue[][]>()
  const nameBySlug = new Map<string, string>()
  for (const row of dataRows) {
    const slug = String(row[layout.slug] ?? '').trim()
    if (!slug) continue // slugless rows cannot form a product tab; the importer errors on them anyway
    let list = bySlug.get(slug)
    if (!list) { list = []; bySlug.set(slug, list); order.push(slug) }
    list.push(row)
    if (!nameBySlug.has(slug) && layout.name >= 0) nameBySlug.set(slug, String(row[layout.name] ?? ''))
  }

  const cell = (row: CellValue[], index: number): CellValue => (index >= 0 ? row[index] ?? '' : '')
  const nonEmpty = (v: CellValue): boolean => String(v).trim() !== ''

  const tabs: ProductTab[] = []
  for (const slug of order) {
    const rows = bySlug.get(slug)!
    // How many option pairs this product uses: the highest index that is non-empty
    // on any of its rows (Option i or its Value i). Contiguous from 1 in practice.
    let usedOptions = 0
    for (const row of rows) {
      for (let i = 1; i <= layout.optionCount; i++) {
        const oi = header.indexOf(`Option ${i}`)
        const vi = header.indexOf(`Value ${i}`)
        if (nonEmpty(cell(row, oi)) || nonEmpty(cell(row, vi))) { if (i > usedOptions) usedOptions = i }
      }
    }
    // Which extra field columns this product has any value in.
    const keptFields = layout.fields.filter((f) => rows.some((row) => nonEmpty(cell(row, f.index))))

    // And which fixed columns it has any value in - the same test, so a product
    // tab carries only the columns that product actually uses (see ALWAYS_COLUMNS).
    const keptFixed = fixedColumns.filter((col) =>
      ALWAYS_COLUMNS.has(col) || rows.some((row) => nonEmpty(cell(row, layout.fixed.get(col) ?? -1)))
    )

    const narrowHeader: string[] = [
      SLUG_HEADER, NAME_HEADER,
      ...optionPairHeaders(usedOptions),
      ...keptFixed,
      ...keptFields.map((f) => f.label),
    ]
    const grid: CellValue[][] = [narrowHeader]
    for (const row of rows) {
      const out: CellValue[] = [cell(row, layout.slug), cell(row, layout.name)]
      for (let i = 1; i <= usedOptions; i++) {
        out.push(cell(row, header.indexOf(`Option ${i}`)), cell(row, header.indexOf(`Value ${i}`)))
      }
      for (const col of keptFixed) out.push(cell(row, layout.fixed.get(col) ?? -1))
      for (const f of keptFields) out.push(cell(row, f.index))
      grid.push(out)
    }
    tabs.push({ slug, name: nameBySlug.get(slug) ?? slug, grid })
  }
  return tabs
}

// Per-product tab grids -> one wide grid with the superset header, the exact
// shape the old single Variations tab produced. Option pairs widen to the widest
// tab; extra field columns are the union across tabs in first-seen order. A cell
// absent from a given tab (an option that tab does not have, a field it does not
// carry) comes through blank - the same padding the old export wrote.
export function mergeVariationTabs(tabGrids: string[][][]): string[][] {
  const layouts = tabGrids.map((g) => ({ grid: g, layout: readLayout(g[0] ?? []) }))
  const maxOptions = layouts.reduce((m, t) => Math.max(m, t.layout.optionCount), 0)

  const fieldOrder: string[] = []
  for (const { layout } of layouts) {
    for (const f of layout.fields) if (!fieldOrder.includes(f.label)) fieldOrder.push(f.label)
  }

  // A fixed column NO tab carries is left out of the merged grid rather than
  // merged in blank. That is what makes a switched-off column (see lib/columns.ts)
  // stop syncing rather than start clearing: the importer skips a column the grid
  // does not have, where a column of blanks reads as "every variant's stock is
  // now nothing". The same holds for a column an owner has deleted by hand.
  const fixedColumns = FIXED_MIDDLE_COLUMNS.filter((col) => layouts.some(({ layout }) => layout.fixed.has(col)))

  const mergedHeader: string[] = [
    SLUG_HEADER, NAME_HEADER,
    ...optionPairHeaders(maxOptions),
    ...fixedColumns,
    ...fieldOrder,
  ]

  const merged: string[][] = [mergedHeader]
  for (const { grid, layout } of layouts) {
    if (layout.slug < 0) continue // not a real variation tab (defensive; caller pre-filters)
    const fieldIndexByLabel = new Map(layout.fields.map((f) => [f.label, f.index]))
    const at = (row: string[], index: number): string => (index >= 0 ? (row[index] ?? '') : '')
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r] ?? []
      // A wholly blank trailing row (Sheets pads short rows) is not a variant.
      if (row.every((c) => (c ?? '').trim() === '')) continue
      const out: string[] = [at(row, layout.slug), at(row, layout.name)]
      for (let i = 1; i <= maxOptions; i++) {
        out.push(at(row, (grid[0] ?? []).indexOf(`Option ${i}`)), at(row, (grid[0] ?? []).indexOf(`Value ${i}`)))
      }
      for (const col of fixedColumns) out.push(at(row, layout.fixed.get(col) ?? -1))
      for (const label of fieldOrder) out.push(at(row, fieldIndexByLabel.get(label) ?? -1))
      merged.push(out)
    }
  }
  return merged
}

// The slugs a merged read actually turned up, so the caller can check them
// against the manifest of what the last Push wrote (see missingManifestSlugs).
export function slugsInMergedGrid(merged: string[][]): Set<string> {
  const layout = readLayout(merged[0] ?? [])
  const slugs = new Set<string>()
  if (layout.slug < 0) return slugs
  for (let r = 1; r < merged.length; r++) {
    const s = (merged[r]?.[layout.slug] ?? '').trim()
    if (s) slugs.add(s)
  }
  return slugs
}

// Which slugs the last Push recorded are NOT present in the sheet the Pull just
// read. A non-empty result means a variation tab has been renamed, deleted or
// emptied since the Push - and merging blind would read its variants as "gone
// from the sheet" and DELETE them. The Pull refuses instead. An empty manifest
// (a workbook pushed before manifests existed) disables the check, matching the
// old single-tab behaviour where a missing tab simply threw.
export function missingManifestSlugs(manifest: readonly string[], present: Set<string>): string[] {
  return manifest.filter((slug) => !present.has(slug))
}
