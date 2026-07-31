import { prisma } from '@/lib/db/prisma'

// Preview→Pull snapshot reuse (migration 010).
//
// Preview and Pull read the same two grids seconds apart; the Pull's re-read
// exists only to guarantee it never runs against a sheet that changed after the
// preview. Drive's modifiedTime gives that guarantee more cheaply: the preview
// stores its grids beside the modifiedTime it read them under, and the Pull
// reuses them only when the sheet's CURRENT modifiedTime is exactly the same
// instant - any hand edit or Push moves it, and the Pull falls back to reading
// fresh. The catalogue diff is recomputed either way (the DATABASE may well have
// changed); only the Google reads are saved.
//
// Everything here is deliberately best-effort on the write side and strict on
// the read side: a failed save costs the next Pull a re-read, never an error.

const SINGLETON = 'singleton'

export type SheetSnapshot = {
  productsGrid: string[][]
  variationsGrid: string[][]
  driveModifiedTime: Date
}

// May the stored snapshot stand in for a fresh read? Only on an exact
// modifiedTime match, and only when both sides actually have a time - Drive
// occasionally answers null, and "unknown" must never read as "unchanged".
// Pure, unit-tested.
export function snapshotIsCurrent(snapshotTime: Date | null, currentTime: Date | null): boolean {
  return snapshotTime !== null && currentTime !== null && snapshotTime.getTime() === currentTime.getTime()
}

// Overwrite the singleton snapshot with what a preview just read. Best-effort:
// callers fire this after answering the owner, and a failure only means the
// next Pull reads the sheet itself.
export async function saveSheetSnapshot(snap: SheetSnapshot): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "gsp_sheet_snapshot" ("id", "products_grid", "variations_grid", "drive_modified_time")
    VALUES (${SINGLETON}, ${JSON.stringify(snap.productsGrid)}::jsonb, ${JSON.stringify(snap.variationsGrid)}::jsonb, ${snap.driveModifiedTime})
    ON CONFLICT ("id") DO UPDATE SET
      "products_grid" = EXCLUDED."products_grid",
      "variations_grid" = EXCLUDED."variations_grid",
      "drive_modified_time" = EXCLUDED."drive_modified_time",
      "updated_at" = CURRENT_TIMESTAMP
  `
}

// The stored snapshot, or null when none has been saved yet.
export async function loadSheetSnapshot(): Promise<SheetSnapshot | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT "products_grid", "variations_grid", "drive_modified_time"
    FROM "gsp_sheet_snapshot" WHERE "id" = ${SINGLETON} LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  const products = r.products_grid
  const variations = r.variations_grid
  const time = r.drive_modified_time
  if (!Array.isArray(products) || !Array.isArray(variations) || !(time instanceof Date)) return null
  return {
    productsGrid: products as string[][],
    variationsGrid: variations as string[][],
    driveModifiedTime: time,
  }
}
