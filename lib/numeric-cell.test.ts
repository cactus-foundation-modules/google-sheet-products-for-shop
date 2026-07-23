import { describe, it, expect } from 'vitest'
import { canonicalNumber, coerceOpenCell } from '@/modules/google-sheet-products-for-shop/lib/numeric-cell'

describe('canonicalNumber', () => {
  it('accepts plain integers and decimals, trimming whitespace', () => {
    expect(canonicalNumber('15')).toBe(15)
    expect(canonicalNumber('15.5')).toBe(15.5)
    expect(canonicalNumber('-3')).toBe(-3)
    expect(canonicalNumber('0')).toBe(0)
    expect(canonicalNumber('  42 ')).toBe(42)
  })

  it('rejects anything that does not round-trip through Number()', () => {
    // A leading zero is meaningful (a code, a barcode) - dropping it would change
    // the value, so it stays text.
    expect(canonicalNumber('0100')).toBeNull()
    // Trailing zero and thousands separator are preformatting, not a bare number.
    expect(canonicalNumber('100.0')).toBeNull()
    expect(canonicalNumber('1,000')).toBeNull()
    // A 17-digit id would silently lose precision as a JS number - keep it text.
    expect(canonicalNumber('90071992547409931')).toBeNull()
    expect(canonicalNumber('12kg')).toBeNull()
    expect(canonicalNumber('')).toBeNull()
    expect(canonicalNumber('   ')).toBeNull()
    expect(canonicalNumber('Infinity')).toBeNull()
    expect(canonicalNumber('NaN')).toBeNull()
  })
})

describe('coerceOpenCell', () => {
  it('turns a canonical number into a JS number so Sheets stores a number cell', () => {
    expect(coerceOpenCell('100')).toBe(100)
    expect(coerceOpenCell('3.14')).toBe(3.14)
    expect(coerceOpenCell('-2.5')).toBe(-2.5)
  })

  it('leaves a code, a mixed value or a blank as text', () => {
    expect(coerceOpenCell('0100')).toBe('0100')
    expect(coerceOpenCell('Large')).toBe('Large')
    expect(coerceOpenCell('12kg')).toBe('12kg')
    expect(coerceOpenCell('')).toBe('')
  })
})
