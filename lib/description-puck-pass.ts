import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { updateProduct } from '@/modules/shop/lib/db/products'
import type { PuckData } from '@/modules/shop/lib/types'
import { matchRowsToProducts } from '@/modules/google-sheet-products-for-shop/lib/row-products'
import {
  DESCRIPTION_PUCK_COLUMN,
  descriptionPuckChanged,
  readDescriptionPuckCell,
} from '@/modules/google-sheet-products-for-shop/lib/description-puck'
import { rowFailureReason } from '@/modules/google-sheet-products-for-shop/lib/failure'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// The designed-description column, applied after shop's import engine has run
// over the same chunk. The engine only knows shop's fixed CSV columns and this
// is not one of them (see lib/description-puck.ts for why it never will be), so
// without this pass a Pull would import every other cell of a row and quietly
// drop the design.
//
// Runs per products chunk, alongside the product-field pass and for the same
// reason: an unbounded pass over a whole catalogue does not fit under the module
// dispatcher's 60s ceiling.

// `grid` is a header row plus the data rows to process. `sheetRowFor(dataIndex)`
// maps a 0-based data-row index within this grid to the row the owner sees.
export async function applyDescriptionPuckPass(
  grid: string[][],
  opts?: { sheetRowFor?: (dataIndex: number) => number },
): Promise<{ updated: number; errors: SyncRowError[] }> {
  const errors: SyncRowError[] = []
  let updated = 0
  const sheetRowFor = opts?.sheetRowFor ?? ((dataIndex: number) => dataIndex + 2)
  if (grid.length < 2) return { updated, errors }

  const { header, matches } = await matchRowsToProducts(grid)
  const col = header.indexOf(DESCRIPTION_PUCK_COLUMN)
  // Column absent from the sheet: not part of this owner's sync at all. Leave
  // every stored design alone - the same way the engine leaves a field alone
  // when its column is missing, rather than reading absence as "blank this".
  if (col < 0) return { updated, errors }

  const productIds = [...new Set(matches.map((m) => m.productId).filter((id): id is string => !!id))]
  if (productIds.length === 0) return { updated, errors }

  // Current state for the whole chunk in one query, so an unchanged row costs no
  // write and a changed one costs no extra read.
  const stored = new Map<string, PuckData | null>()
  const rows = await prisma.$queryRaw<{ id: string; description_puck: unknown }[]>`
    SELECT "id", "description_puck" FROM "shp_products" WHERE "id" IN (${Prisma.join(productIds)})
  `
  for (const r of rows) stored.set(r.id, (r.description_puck as PuckData | null) ?? null)

  for (const match of matches) {
    if (!match.productId) continue // the engine could not match it either; its own error stands
    const cell = (match.row[col] ?? '').trim()
    const current = stored.get(match.productId) ?? null
    if (!descriptionPuckChanged(cell, current)) continue

    const read = readDescriptionPuckCell(cell)
    if (read.kind === 'invalid') {
      // Never guess at a document we cannot read: report the row and leave the
      // stored design standing. A half-understood write here would replace a
      // working product page with a broken one.
      errors.push({ row: sheetRowFor(match.dataIndex), reason: read.reason })
      continue
    }
    if (read.kind === 'skip') continue

    try {
      await updateProduct(match.productId, { descriptionPuck: read.kind === 'clear' ? null : read.data })
      updated++
    } catch (err) {
      errors.push({ row: sheetRowFor(match.dataIndex), reason: rowFailureReason(err, 'Description design update failed') })
    }
  }

  return { updated, errors }
}
