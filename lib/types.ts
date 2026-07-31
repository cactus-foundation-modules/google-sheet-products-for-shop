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
  // Bumped after every tab a Push writes, so the "sheet edited since we synced"
  // guard tracks our own partial writes without moving the deletion baseline.
  lastPushAttemptAt: Date | null
  // The variation tabs the last Push wrote, one entry per variable product. The
  // Pull checks every slug here is still present in the sheet before merging, so a
  // renamed or deleted tab is caught rather than read as "these variants are gone"
  // (see lib/variation-tabs.ts missingManifestSlugs). Null before the first Push.
  // `hash` fingerprints the grid that Push wrote (see lib/grid-hash.ts) so the
  // next Push can skip a tab whose content has not moved; absent on manifests
  // written before it existed, which simply means no skipping that first time.
  variationTabManifest: Array<{ slug: string; title: string; hash?: string }> | null
}

export type SyncDirection = 'PUSH' | 'PULL'
export type SyncTab = 'PRODUCTS' | 'VARIATIONS'
export type SyncStatus = 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED'
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
  // parentName absent on plans stored before it existed; only childProductId is
  // ever read back at delete time.
  variations: Array<{ childProductId: string; parentSlug: string; parentName?: string; label: string }>
}

export type PullJob = {
  id: string
  status: PullJobStatus
  phase: PullPhase
  productsGrid: string[][] | null
  variationsGrid: string[][] | null
  // Original 1-based sheet row number for each kept data row of the grids above,
  // so a row error points at the owner's sheet, not the filtered snapshot. Null
  // on jobs created before these existed.
  productsRowMap: number[] | null
  variationsRowMap: number[] | null
  deletionPlan: StoredDeletionPlan | null
  lastPushAt: Date | null
  shopImportJobId: string | null
  detected: PullDetected | null
  productsTotal: number
  productsDone: number
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
  // Live commentary from the importers: the row being written right now, how
  // many rows of the chunk in flight are behind it, and the last few that went
  // through (newest first). Display only - the resume cursor is still
  // productsDone / variationsDone, which only ever move at a chunk boundary.
  currentItem: string | null
  currentOffset: number
  recentItems: string[] | null
  error: string | null
  runBy: string | null
  createdAt: Date
}

// --- Resumable Push job ----------------------------------------------------

export type PushPhase = 'PRODUCTS' | 'VARIATION_TABS' | 'CLEANUP' | 'DONE'
export type PushJobStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

// One variable product's tab: the stable slug it is matched by, the display name,
// the tab title it is written to, and the narrow grid (only its own option and
// field columns). Built once at Push start and stored on the job.
export type PushVariationTab = {
  slug: string
  name: string
  title: string
  grid: (string | number | boolean)[][]
}

export type PushJob = {
  id: string
  status: PushJobStatus
  phase: PushPhase
  force: boolean
  productsGrid: (string | number | boolean)[][] | null
  variationTabs: PushVariationTab[] | null
  writtenTitles: string[] | null
  tabsTotal: number
  tabsDone: number
  productsRows: number
  variationsRows: number
  suppliersRows: number
  formulasKept: number
  error: string | null
  runBy: string | null
  createdAt: Date
}

// The live snapshot the browser polls while a Push runs (and on Continue).
export type PushStatus = {
  pushJobId: string
  status: PushJobStatus
  phase: PushPhase
  done: boolean
  tabsTotal: number
  tabsDone: number
  counts: {
    productsRows: number
    variationsRows: number
    suppliersRows: number
    formulasKept: number
  }
  error: string | null
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
  // The row being written as this snapshot was taken, and the last few finished
  // (newest first) - what the dialog names while the bars move.
  currentItem: string | null
  recentItems: string[]
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
  variations: {
    toCreate: number
    // Which variation each changing row touches - parent product plus the
    // variant's option label (e.g. "Oak / 1600mm").
    toUpdate: Array<{ parentName: string; label: string }>
    // On the site but absent from the sheet - Pull deletes these child products.
    toDelete: Array<{ childProductId: string; parentName: string; label: string }>
    unchanged: number
    rowErrors: SyncRowError[]
  }
  staleness: { changedSinceLastPush: number; since: string | null }
  // Required Products columns the sheet header is missing (Pull will refuse).
  headerMissing: string[]
}
