import { describe, it, expect } from 'vitest'
import { snapshotIsCurrent } from '@/modules/google-sheet-products-for-shop/lib/sheet-snapshot'

// The reuse decision is deliberately strict: EXACT modifiedTime equality, and
// "unknown" on either side must never read as "unchanged" - a wrongly reused
// snapshot would run the Pull against grids the owner has since edited.
describe('snapshotIsCurrent', () => {
  const t = new Date('2026-07-31T10:00:00.000Z')

  it('true only on the exact same instant', () => {
    expect(snapshotIsCurrent(t, new Date(t.getTime()))).toBe(true)
  })

  it('false when the sheet moved on - even by a millisecond', () => {
    expect(snapshotIsCurrent(t, new Date(t.getTime() + 1))).toBe(false)
    expect(snapshotIsCurrent(t, new Date(t.getTime() - 1))).toBe(false)
  })

  it('false when either side is unknown', () => {
    expect(snapshotIsCurrent(null, t)).toBe(false)
    expect(snapshotIsCurrent(t, null)).toBe(false)
    expect(snapshotIsCurrent(null, null)).toBe(false)
  })
})
