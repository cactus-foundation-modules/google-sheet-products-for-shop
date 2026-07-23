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

// --- Resumable Pull job ----------------------------------------------------

export type PullPhase = 'PRODUCTS' | 'DELETIONS' | 'VARIATIONS' | 'DONE'
export type PullJobStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

// The confirm dialog's headline counts, stored for display only (so a Continue
// resumed on a fresh page load can still say what the Pull is about). Computed
// server-side at start from the same diff that filters the grids - never taken
// from the browser. The unchanged counts are the rows the diff proved identical
// and the Pull therefore skips; optional because jobs created before they
// existed have none.
export type PullDetected = {
  productsCreate: number
  productsUpdate: number
  productsDelete: number
  variationsCreate: number
  variationsUpdate: number
  variationsDelete: number
  productsUnchanged?: number
  variationsUnchanged?: number
}

// The deletion side of the Pull, planned once at start (from the FULL sheet
// snapshot, before unchanged rows are filtered out) and stored on the job - the
// DELETIONS phase applies exactly this list, so what the confirm dialog showed
// is what gets removed. Shape matches lib/deletions.ts's PullDeletionPlan.
export type StoredDeletionPlan = {
  products: Array<{ id: string; sku: string | null; name: string }>
  variations: Array<{ childProductId: string; parentSlug: string; label: string }>
}

export type PullJob = {
  id: string
  status: PullJobStatus
  phase: PullPhase
  productsGrid: string[][] | null
  variationsGrid: string[][] | null
  deletionPlan: StoredDeletionPlan | null
  lastPushAt: Date | null
  shopImportJobId: string | null
  detected: PullDetected | null
  productsTotal: number
  variationsTotal: number
  variationsDone: number
  prodCreated: number
  prodUpdated: number
  prodSkipped: number
  prodDeleted: number
  varCreated: number
  varUpdated: number
  varDeleted: number
  prodErrors: SyncRowError[] | null
  varErrors: SyncRowError[] | null
  error: string | null
  runBy: string | null
  createdAt: Date
}

// The live snapshot the browser polls while a Pull runs (and on Continue). All
// the numbers the progress UI needs, without shipping the grids.
export type PullStatus = {
  pullJobId: string
  status: PullJobStatus
  phase: PullPhase
  done: boolean
  productsTotal: number
  productsDone: number
  variationsTotal: number
  variationsDone: number
  detected: PullDetected | null
  counts: {
    productsCreated: number
    productsUpdated: number
    productsDeleted: number
    variationsCreated: number
    variationsUpdated: number
    variationsDeleted: number
  }
  errorCount: number
  error: string | null
}

// What a Pull is about to do, computed without writing anything. The preview
// runs the same validation the engines apply, so the confirm dialog's counts
// match what actually happens.
export type PullPreview = {
  products: {
    toCreate: Array<{ sku: string | null; name: string }>
    toUpdate: Array<{ sku: string | null; name: string; changes: Array<{ field: string; from: string; to: string }> }>
    // In the shop (non-hidden) but not in the sheet, and present as of the last
    // push. Pull deletes these outright, along with any variants they carry.
    toDelete: Array<{ id: string; sku: string | null; name: string }>
    // Rows that match the shop cell-for-cell; the Pull skips them entirely.
    unchanged: number
    rowErrors: SyncRowError[]
  }
  variations: { toCreate: number; toUpdate: number; toDelete: number; unchanged: number; rowErrors: SyncRowError[] }
  staleness: { changedSinceLastPush: number; since: string | null }
  // Required Products columns the sheet header is missing (Pull will refuse).
  headerMissing: string[]
}
