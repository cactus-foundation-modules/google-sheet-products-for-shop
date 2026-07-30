// Grouping for values.batchGet calls - pure string arithmetic, no I/O, so it
// lives apart from lib/sheets.ts and its token/DB imports and gets a plain unit
// test.
//
// Why grouping exists at all: Google counts a batchGet as ONE read against the
// sixty-reads-a-minute quota however many ranges it carries, so the cheapest way
// to read a several-hundred-tab workbook is as few batchGets as possible. But
// every range rides in the request URL, and past ~8KB of URL Google answers with
// an error rather than data. So: as many tabs per call as the URL can safely
// carry, and no more.

// A1 range for a whole tab, or a tab anchored at a cell. Tab titles are quoted
// so a title with a space ("Read me") is still a valid range.
export function tabRange(tab: string, a1?: string): string {
  return encodeURIComponent(a1 ? `'${tab}'!${a1}` : `'${tab}'`)
}

// Caps per batchGet call. Forty tabs of ordinary titles sit far inside both; a
// workbook of hundred-character titles (Google's own tab-title cap, ~300 chars
// once URL-encoded) is what the character budget is for. Both deliberately
// modest - another call costs one quota token, a rejected URL costs the whole
// read.
export const BATCH_GET_MAX_RANGES = 40
export const BATCH_GET_MAX_RANGE_CHARS = 6000

// Split tab titles into groups whose combined `ranges=` query parameters fit one
// batchGet URL. Order is preserved, every tab lands in exactly one group, and a
// single oversized title still gets a group of its own rather than being dropped.
// `a1` narrows each range to a cell run within its tab (e.g. '1:1' for header
// rows), matching what the caller will actually put in the URL.
export function batchGetGroups(tabs: string[], a1?: string): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let chars = 0
  for (const tab of tabs) {
    const len = `ranges=${tabRange(tab, a1)}&`.length
    if (current.length > 0 && (current.length >= BATCH_GET_MAX_RANGES || chars + len > BATCH_GET_MAX_RANGE_CHARS)) {
      groups.push(current)
      current = []
      chars = 0
    }
    current.push(tab)
    chars += len
  }
  if (current.length > 0) groups.push(current)
  return groups
}
