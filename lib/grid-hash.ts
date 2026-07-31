import { createHash } from 'node:crypto'
import type { CellValue } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// A stable fingerprint of one tab's grid, stored in the variation-tab manifest at
// the end of a successful Push. The next Push compares the fingerprint of the grid
// it is ABOUT to write with the one it wrote LAST time: equal, and the sheet not
// touched since (Drive modifiedTime), means the tab already holds exactly this
// content and every read and write for it can be skipped. JSON.stringify is
// stable here because a grid is arrays of primitives - no object keys to reorder.
export function gridHash(grid: CellValue[][]): string {
  return createHash('sha256').update(JSON.stringify(grid)).digest('hex')
}
