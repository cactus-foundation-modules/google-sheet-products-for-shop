import { describe, it, expect } from 'vitest'
import { desiredTabOrder, sameOrder, reorderRequests } from '@/modules/google-sheet-products-for-shop/lib/tab-order'
import { TAB_ORDER } from '@/modules/google-sheet-products-for-shop/lib/workbook'

type MoveRequest = { updateSheetProperties: { properties: { sheetId: number; index: number }; fields: string } }

const order = (current: string[], variations: string[]) =>
  desiredTabOrder(current, new Set(variations), TAB_ORDER)

describe('desiredTabOrder', () => {
  it('puts the three fixed tabs first, then the product tabs A-Z', () => {
    // The shape a freshly built workbook has: product tabs appended as they were
    // created, in no order anyone would choose.
    const current = ['Products', 'Suppliers', 'Read me', 'Oslo Desk', 'Academy Chair', 'Air Desk']
    expect(order(current, ['Oslo Desk', 'Academy Chair', 'Air Desk'])).toEqual([
      'Products', 'Suppliers', 'Read me', 'Academy Chair', 'Air Desk', 'Oslo Desk',
    ])
  })

  it('rescues the fixed tabs from wherever the old insert-at-1 left them', () => {
    // What a workbook built by the previous version looks like: every product tab
    // slotted after Products, shunting Suppliers and Read me to the far end.
    const current = ['Products', 'Zeta Chair', 'Alpha Desk', 'Suppliers', 'Read me']
    expect(order(current, ['Zeta Chair', 'Alpha Desk'])).toEqual([
      'Products', 'Suppliers', 'Read me', 'Alpha Desk', 'Zeta Chair',
    ])
  })

  it("keeps the owner's own tabs after the product tabs, in their own order", () => {
    const current = ['Pricing report', 'Products', 'Beta Chair', 'Scratch', 'Alpha Desk', 'Suppliers', 'Read me']
    expect(order(current, ['Beta Chair', 'Alpha Desk'])).toEqual([
      'Products', 'Suppliers', 'Read me', 'Alpha Desk', 'Beta Chair', 'Pricing report', 'Scratch',
    ])
  })

  it('sorts the way a person reads, not the way a computer does', () => {
    const titles = ['air desk 1200mm', 'Air Desk 800mm', 'Air Desk 1000mm']
    expect(order(['Products', ...titles], titles)).toEqual([
      'Products', 'Air Desk 800mm', 'Air Desk 1000mm', 'air desk 1200mm',
    ])
  })

  it('skips a fixed tab the workbook does not have', () => {
    // An older sheet, made before the Suppliers tab existed.
    const current = ['Products', 'Read me', 'Beta', 'Alpha']
    expect(order(current, ['Beta', 'Alpha'])).toEqual(['Products', 'Read me', 'Alpha', 'Beta'])
  })

  it('never invents, drops or duplicates a tab', () => {
    const current = ['Zeta', 'Products', 'Alpha', 'Mine', 'Read me', 'Suppliers']
    const result = order(current, ['Zeta', 'Alpha'])
    expect([...result].sort()).toEqual([...current].sort())
  })
})

describe('sameOrder', () => {
  it('spots a settled workbook so a Push spends no write on it', () => {
    const settled = ['Products', 'Suppliers', 'Read me', 'Alpha', 'Beta']
    expect(sameOrder(settled, order(settled, ['Alpha', 'Beta']))).toBe(true)
  })

  it('is not fooled by the same tabs in a different order', () => {
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('reorderRequests', () => {
  it('moves tabs in ascending position, which is the direction Google gets right', () => {
    const ids = new Map([['Products', 0], ['Alpha', 5], ['Beta', 7]])
    const requests = reorderRequests(['Products', 'Alpha', 'Beta'], ids) as MoveRequest[]
    expect(requests.map((r) => r.updateSheetProperties.properties)).toEqual([
      { sheetId: 0, index: 0 },
      { sheetId: 5, index: 1 },
      { sheetId: 7, index: 2 },
    ])
    expect(requests.every((r) => r.updateSheetProperties.fields === 'index')).toBe(true)
  })

  it('leaves out a tab that vanished between the read and the write', () => {
    const requests = reorderRequests(['Products', 'Gone'], new Map([['Products', 0]])) as MoveRequest[]
    expect(requests).toHaveLength(1)
  })
})
