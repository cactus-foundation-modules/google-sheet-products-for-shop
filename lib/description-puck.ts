import type { PuckData } from '@/modules/shop/lib/types'

// The designed-description column: shp_products.description_puck, the Puck
// document the storefront renders in place of the plain-text `description` when
// it has content. It is NOT one of shop's CSV columns and deliberately never
// will be - a JSON document has no business in a CSV a human opens by hand, and
// shop's own export/import is left exactly as it was. It is a column this module
// adds to its own Products grid, filled on Push and applied on Pull, sitting
// after the fixed columns and before any product-field provider's.
//
// Everything about how the cell behaves lives here, so Push, the Pull diff and
// the Pull's write-back can never drift into three different opinions of what a
// given cell means.
export const DESCRIPTION_PUCK_COLUMN = 'description_puck'

// A Sheets cell holds at most 50,000 characters. A document longer than that
// cannot round-trip, and writing a truncated one would be far worse than not
// writing it at all - the next Pull would read the fragment back and destroy the
// real document. So an oversized document is replaced by this sentinel, which
// Pull reads as "leave this product's design alone". The margin under the hard
// limit is deliberate: it costs nothing and no design worth hand-editing in a
// spreadsheet is anywhere near it.
export const CELL_CHAR_LIMIT = 45_000
export const TOO_LARGE_CELL = '(design too large for a cell - edit this one in the admin)'

// What a Push writes for one product: the document as compact JSON, blank when
// the product has none. Compact rather than pretty-printed because the cell is a
// single line either way and every newline is a character off the budget.
export function descriptionPuckCell(puck: PuckData | null | undefined): string {
  if (!puck) return ''
  const json = JSON.stringify(puck)
  return json.length > CELL_CHAR_LIMIT ? TOO_LARGE_CELL : json
}

export type DescriptionPuckCell =
  // Blank: the owner wants no designed description, so Pull clears the column
  // and the storefront falls back to the plain-text one.
  | { kind: 'clear' }
  // The sentinel a Push writes for an oversized document. Untouched by the
  // owner, so there is nothing to apply and nothing to report as a change.
  | { kind: 'skip' }
  | { kind: 'doc'; data: PuckData }
  // Anything we cannot positively read as a Puck document. Never guessed at and
  // never written: the row is reported as an error and the stored design stands.
  | { kind: 'invalid'; reason: string }

// Read one sheet cell. Conservative by design - see the module's diff rules: a
// cell we cannot prove is a document is an error, never a "best effort" write.
export function readDescriptionPuckCell(cell: string): DescriptionPuckCell {
  const text = cell.trim()
  if (text === '') return { kind: 'clear' }
  if (text === TOO_LARGE_CELL) return { kind: 'skip' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'invalid', reason: 'The description design is not valid JSON. Copy it back from the admin, or clear the cell to remove the design.' }
  }
  if (!isPuckData(parsed)) {
    return { kind: 'invalid', reason: 'The description design is JSON but not a page design (it needs a "content" list and a "root"). Clear the cell to remove the design.' }
  }
  return { kind: 'doc', data: parsed }
}

// The shape Puck stores and the storefront renders: a content list plus a root.
// Checked rather than trusted, because this value is written straight into a
// jsonb column the product page reads back and renders.
function isPuckData(value: unknown): value is PuckData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.content)) return false
  if (typeof v.root !== 'object' || v.root === null || Array.isArray(v.root)) return false
  if (v.zones !== undefined && (typeof v.zones !== 'object' || v.zones === null || Array.isArray(v.zones))) return false
  return true
}

// Stable JSON: objects keyed in sorted order, arrays left alone (block order is
// meaning, not noise). The diff compares two documents through this so a sheet
// cell an owner has re-indented, or one whose keys came back in another order,
// is not read as an edit and dragged through the importer on every Pull.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

// Would applying this cell change the product's stored design? `stored` is what
// the product holds now. Anything we cannot prove equal counts as a change: the
// write is then a no-op at worst, where a wrong "unchanged" loses the edit.
export function descriptionPuckChanged(cell: string, stored: PuckData | null | undefined): boolean {
  const current = stored ?? null
  const read = readDescriptionPuckCell(cell)
  if (read.kind === 'skip') return false
  if (read.kind === 'invalid') return true
  if (read.kind === 'clear') return current !== null
  if (current === null) return true
  return canonicalJson(read.data) !== canonicalJson(current)
}

// A short label for the confirm dialog. The raw values are whole JSON documents,
// and the dialog prints every change inline - one unabridged document would bury
// the rest of the list, so both sides of a design change are described instead.
export function describeDescriptionPuck(puck: PuckData | null | undefined): string {
  if (!puck) return 'no design'
  const blocks = Array.isArray(puck.content) ? puck.content.length : 0
  return `design (${blocks} ${blocks === 1 ? 'block' : 'blocks'})`
}

export function describeDescriptionPuckCell(cell: string): string {
  const read = readDescriptionPuckCell(cell)
  if (read.kind === 'clear') return 'no design'
  if (read.kind === 'skip') return 'left as it is'
  if (read.kind === 'invalid') return 'unreadable design'
  return describeDescriptionPuck(read.data)
}
