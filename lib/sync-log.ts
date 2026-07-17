import { prisma } from '@/lib/db/prisma'
import type { GspSyncLog, SyncDirection, SyncTab, SyncStatus, SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

export type SyncLogEntry = {
  direction: SyncDirection
  tab: SyncTab
  status: SyncStatus
  createdCount?: number
  updatedCount?: number
  skippedCount?: number
  archivedCount?: number
  errors?: SyncRowError[] | null
  runBy?: string | null
}

export async function writeSyncLog(entry: SyncLogEntry): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "gsp_sync_log"
      ("direction", "tab", "status", "created_count", "updated_count", "skipped_count", "archived_count", "errors", "run_by")
    VALUES (
      ${entry.direction}, ${entry.tab}, ${entry.status},
      ${entry.createdCount ?? 0}, ${entry.updatedCount ?? 0}, ${entry.skippedCount ?? 0}, ${entry.archivedCount ?? 0},
      ${entry.errors && entry.errors.length ? JSON.stringify(entry.errors) : null}::jsonb, ${entry.runBy ?? null}
    )
  `
}

export async function listRecentSyncLogs(limit = 20): Promise<GspSyncLog[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gsp_sync_log" ORDER BY "created_at" DESC LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id as string,
    direction: r.direction as SyncDirection,
    tab: r.tab as SyncTab,
    status: r.status as SyncStatus,
    createdCount: r.created_count as number,
    updatedCount: r.updated_count as number,
    skippedCount: r.skipped_count as number,
    archivedCount: r.archived_count as number,
    errors: (r.errors as SyncRowError[] | null) ?? null,
    runBy: (r.run_by as string | null) ?? null,
    createdAt: r.created_at as Date,
  }))
}
