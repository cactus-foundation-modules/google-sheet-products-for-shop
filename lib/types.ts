// Shared types for the Google Sheet Products module.

export type GspConnection = {
  id: string
  oauthClientIdEncrypted: string | null
  oauthClientSecretEncrypted: string | null
  oauthAccessTokenEncrypted: string | null
  oauthRefreshTokenEncrypted: string | null
  oauthTokenExpiresAt: Date | null
  googleAccountEmail: string | null
  spreadsheetId: string | null
  spreadsheetUrl: string | null
  includeCostPrice: boolean
  lastPushAt: Date | null
  lastPullAt: Date | null
}

export type SyncDirection = 'PUSH' | 'PULL'
export type SyncTab = 'PRODUCTS' | 'VARIATIONS'
export type SyncStatus = 'COMPLETED' | 'FAILED'
export type SyncRowError = { row: number; reason: string }

export type GspSyncLog = {
  id: string
  direction: SyncDirection
  tab: SyncTab
  status: SyncStatus
  createdCount: number
  updatedCount: number
  skippedCount: number
  archivedCount: number
  errors: SyncRowError[] | null
  runBy: string | null
  createdAt: Date
}

// What a Pull is about to do, computed without writing anything. The preview
// runs the same validation the engines apply, so the confirm dialog's counts
// match what actually happens.
export type PullPreview = {
  products: {
    toCreate: Array<{ sku: string | null; name: string }>
    toUpdate: Array<{ sku: string | null; name: string; changes: Array<{ field: string; from: string; to: string }> }>
    // Archive candidates: in the shop (non-hidden, not already archived) but not
    // in the sheet. Default action is nothing; the admin ticks any to archive.
    missingFromSheet: Array<{ id: string; sku: string; name: string; status: string }>
    rowErrors: SyncRowError[]
  }
  variations: { toCreate: number; toUpdate: number; toDelete: number; rowErrors: SyncRowError[] }
  staleness: { changedSinceLastPush: number; since: string | null }
  // Required Products columns the sheet header is missing (Pull will refuse).
  headerMissing: string[]
}
