import { describe, it, expect } from 'vitest'
import { batchGetGroups, tabRange, BATCH_GET_MAX_RANGES, BATCH_GET_MAX_RANGE_CHARS } from './batch-ranges'

// The invariants the URL depends on: every tab in exactly one group, order kept,
// no group past the range cap, and no group past the character budget unless it
// is a single tab that busts it on its own (which must still be sent, not lost).
function checkInvariants(tabs: string[], a1?: string) {
  const groups = batchGetGroups(tabs, a1)
  expect(groups.flat()).toEqual(tabs)
  for (const group of groups) {
    expect(group.length).toBeGreaterThan(0)
    expect(group.length).toBeLessThanOrEqual(BATCH_GET_MAX_RANGES)
    const chars = group.reduce((n, t) => n + `ranges=${tabRange(t, a1)}&`.length, 0)
    if (group.length > 1) expect(chars).toBeLessThanOrEqual(BATCH_GET_MAX_RANGE_CHARS)
  }
  return groups
}

describe('batchGetGroups', () => {
  it('returns nothing for no tabs', () => {
    expect(batchGetGroups([])).toEqual([])
  })

  it('keeps a small workbook in one group, in order', () => {
    const groups = checkInvariants(['Products', 'Oak Desk', 'Read me'])
    expect(groups).toEqual([['Products', 'Oak Desk', 'Read me']])
  })

  it('splits a big workbook at the range cap', () => {
    const tabs = Array.from({ length: 130 }, (_, i) => `Product ${i}`)
    const groups = checkInvariants(tabs)
    expect(groups.length).toBe(Math.ceil(130 / BATCH_GET_MAX_RANGES))
    expect(groups[0]!.length).toBe(BATCH_GET_MAX_RANGES)
  })

  it('splits earlier when titles are long enough to threaten the URL', () => {
    // 100-char titles (Google's own cap) of characters that URL-encode to six
    // characters each (%C3%A4) - the worst case the character budget exists for.
    const tabs = Array.from({ length: 60 }, (_, i) => `${'ä'.repeat(96)}${String(i).padStart(4, '0')}`)
    const groups = checkInvariants(tabs)
    expect(groups.length).toBeGreaterThan(Math.ceil(60 / BATCH_GET_MAX_RANGES))
  })

  it('never drops a single tab that alone exceeds the budget', () => {
    const monster = 'ä'.repeat(3000)
    const groups = checkInvariants(['Before', monster, 'After'])
    expect(groups.flat()).toContain(monster)
    // The monster sits in a group of its own rather than dragging others past the cap.
    expect(groups.find((g) => g.includes(monster))).toEqual([monster])
  })

  it('accounts for the per-range a1 suffix', () => {
    const tabs = ['One', 'Two']
    expect(checkInvariants(tabs, '1:1')).toEqual([['One', 'Two']])
  })
})
