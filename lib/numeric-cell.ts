import type { CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// Deciding, for a cell whose column has no fixed numeric/text classification,
// whether it should go into the sheet as a number or as text.
//
// The two tabs carry open-ended columns - custom attributes and any extra field
// another module hangs on the grid. One such column is a price, the next is a
// size code like "0100"; nothing in the header tells the two apart. Writing a
// numeric one as a STRING under valueInputOption=RAW is the bug this exists to
// stop: Sheets stores it as a TEXT cell, shows it as '100, refuses to sum or sort
// it, AND defeats formula preservation (a text new-value is compared character for
// character with no float tolerance, so "=B2*1.2" coming out 15.000000000000002
// never equals the string "15" and the owner's formula is replaced on every Push).
//
// The rule is deliberately generic so a numeric column added in the future needs
// no allowlist entry to be safe: a string is treated as a number ONLY when doing
// so is loss-less - it round-trips through Number() back to exactly itself. That
// keeps "15", "15.5", "-3" and "0" as real numbers, while "0100" (leading zero),
// "100.0" (trailing zero), "1,000" (separator), "12kg" and a 17-digit id that
// would lose precision all stay text, untouched. Blank stays blank.

// Numbers that came through a spreadsheet formula are rarely bit-identical to
// the number the database holds: "=12.5*1.2" evaluates to 15.000000000000002,
// not 15. This relative tolerance is shared by formula preservation (Push) and
// the row diff (Pull) so the two sides agree on what "the same number" means:
// a formula Push preserves MUST read as unchanged to the Pull that follows it,
// or every preserved formula flags its row as an update forever (the noise can
// never be imported away - the database column's scale rounds it right back).
export const NUMERIC_TOLERANCE = 1e-9

export function numbersMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
}

// The value as a canonical number, or null when the string is not one. Canonical
// means String(Number(s)) === s: the number carries everything the string did.
export function canonicalNumber(value: string): number | null {
  const t = value.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && String(n) === t ? n : null
}

// Coerce an open-ended cell to the type Sheets should store: a canonical number
// becomes a JS number, everything else (blank included) stays text.
export function coerceOpenCell(value: string): CellValue {
  const n = canonicalNumber(value)
  return n === null ? value : n
}
