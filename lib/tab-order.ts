// Where each tab sits along the bottom of the workbook.
//
// Product tabs used to be created with `index: 1` - slotted straight after
// Products - so a Push that created three hundred of them left them in roughly
// reverse order of creation, with Suppliers and Read me shoved along to the far
// end. Finding one product among three hundred and forty-nine meant scrolling.
//
// The order this settles on:
//   1. Products, Suppliers, Read me - always the first three, in that order.
//   2. Every product tab, A-Z.
//   3. Anything else, in the order it already had - the owner's own tabs. They
//      have to follow the product tabs, since the product tabs are contiguous
//      from position three, but their order relative to each other is theirs.
//
// Pure, so the ordering is pinned by tests rather than by looking at a sheet.

// A-Z as a person reads it: case-insensitive, and "800mm" before "1200mm"
// rather than after it, which a plain string sort gets backwards.
const collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' })

/**
 * The order the tabs should be in, given the order they ARE in.
 *
 * `current` is every tab title in its present order; `variationTitles` are the
 * product tabs this Push wrote; `fixedOrder` is the reserved tabs that lead.
 * A fixed tab that is not in the workbook (an older sheet with no Suppliers tab)
 * is simply skipped rather than invented.
 */
export function desiredTabOrder(
  current: readonly string[],
  variationTitles: ReadonlySet<string>,
  fixedOrder: readonly string[],
): string[] {
  const fixed = fixedOrder.filter((t) => current.includes(t))
  const placed = new Set(fixed)

  const variations = current.filter((t) => !placed.has(t) && variationTitles.has(t)).sort(collator.compare)
  for (const t of variations) placed.add(t)

  const rest = current.filter((t) => !placed.has(t))

  return [...fixed, ...variations, ...rest]
}

/** True when two orderings are the same, so a settled sheet costs no write. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

/**
 * The moves that turn `current` into `desired`, as spreadsheets.batchUpdate
 * requests.
 *
 * Emitted in ASCENDING target position, and that matters. Google's
 * updateSheetProperties moves a sheet by taking it out of the list and putting
 * it back, so a move to a HIGHER index lands one place short of where you asked.
 * Placing position 0 first, then 1, then 2 sidesteps it entirely: by the time a
 * tab is placed, every position before it is already correct and the tab itself
 * is always somewhere at or after its target, which is the direction that has no
 * ambiguity.
 */
export function reorderRequests(desired: readonly string[], sheetIdByTitle: ReadonlyMap<string, number>): unknown[] {
  const requests: unknown[] = []
  desired.forEach((title, index) => {
    const sheetId = sheetIdByTitle.get(title)
    if (sheetId === undefined) return
    requests.push({ updateSheetProperties: { properties: { sheetId, index }, fields: 'index' } })
  })
  return requests
}
