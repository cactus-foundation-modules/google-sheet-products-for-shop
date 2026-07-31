import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import type { GspConnection } from '@/modules/google-sheet-products-for-shop/lib/types'

// The connection is a single row. We key every write on a fixed id so there is
// never more than one, mirroring rc_mailbox_config's singleton shape (the
// migration's gen_random_uuid default only matters if a row is ever inserted
// without this module's helpers, which never happens).
const SINGLETON = 'singleton'

function mapConnection(r: Record<string, unknown>): GspConnection {
  return {
    id: r.id as string,
    oauthClientIdEncrypted: (r.oauth_client_id_encrypted as string | null) ?? null,
    oauthClientSecretEncrypted: (r.oauth_client_secret_encrypted as string | null) ?? null,
    oauthAccessTokenEncrypted: (r.oauth_access_token_encrypted as string | null) ?? null,
    oauthRefreshTokenEncrypted: (r.oauth_refresh_token_encrypted as string | null) ?? null,
    oauthTokenExpiresAt: (r.oauth_token_expires_at as Date | null) ?? null,
    googleAccountEmail: (r.google_account_email as string | null) ?? null,
    spreadsheetId: (r.spreadsheet_id as string | null) ?? null,
    spreadsheetUrl: (r.spreadsheet_url as string | null) ?? null,
    lastPushAt: (r.last_push_at as Date | null) ?? null,
    lastPullAt: (r.last_pull_at as Date | null) ?? null,
    lastPushAttemptAt: (r.last_push_attempt_at as Date | null) ?? null,
    variationTabManifest: Array.isArray(r.variation_tab_manifest)
      ? (r.variation_tab_manifest as Array<{ slug: string; title: string; hash?: string }>)
      : null,
  }
}

// Returns the raw row (encrypted fields present but never decrypted here). Callers
// that only need status/booleans use this; callers that need plaintext use the
// dedicated decrypt-out accessors below.
export async function getConnection(): Promise<GspConnection | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "gsp_connection" ORDER BY "created_at" ASC LIMIT 1
  `
  return rows[0] ? mapConnection(rows[0]) : null
}

// Ensures the singleton row exists so every setter can UPDATE it.
async function ensureRow(): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "gsp_connection" ("id") VALUES (${SINGLETON})
    ON CONFLICT ("id") DO NOTHING
  `
}

// --- OAuth client (encrypt in / decrypt out) ------------------------------

export async function saveOAuthClient(clientId: string, clientSecret: string): Promise<void> {
  await ensureRow()
  await prisma.$executeRaw`
    UPDATE "gsp_connection" SET
      "oauth_client_id_encrypted" = ${encryptSecret(clientId)},
      "oauth_client_secret_encrypted" = ${encryptSecret(clientSecret)},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

export async function getOAuthClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  const conn = await getConnection()
  const clientId = tryDecryptSecret(conn?.oauthClientIdEncrypted)
  const clientSecret = tryDecryptSecret(conn?.oauthClientSecretEncrypted)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

// --- OAuth tokens (encrypt in / decrypt out) ------------------------------

export async function storeTokens(opts: {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  googleAccountEmail: string | null
}): Promise<void> {
  await ensureRow()
  await prisma.$executeRaw`
    UPDATE "gsp_connection" SET
      "oauth_access_token_encrypted" = ${encryptSecret(opts.accessToken)},
      "oauth_refresh_token_encrypted" = ${encryptSecret(opts.refreshToken)},
      "oauth_token_expires_at" = ${opts.expiresAt},
      "google_account_email" = ${opts.googleAccountEmail},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

// Refresh returns no new refresh token, so we only touch the access token and
// its expiry - the stored refresh token is deliberately left in place.
export async function updateAccessToken(opts: { accessToken: string; expiresAt: Date }): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_connection" SET
      "oauth_access_token_encrypted" = ${encryptSecret(opts.accessToken)},
      "oauth_token_expires_at" = ${opts.expiresAt},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

export async function getTokens(): Promise<{ accessToken: string | null; refreshToken: string | null; expiresAt: Date | null } | null> {
  const conn = await getConnection()
  if (!conn) return null
  return {
    accessToken: tryDecryptSecret(conn.oauthAccessTokenEncrypted),
    refreshToken: tryDecryptSecret(conn.oauthRefreshTokenEncrypted),
    expiresAt: conn.oauthTokenExpiresAt,
  }
}

// Disconnect: drop the tokens and the connected-account display, but keep the
// client id/secret and the spreadsheet pointer so reconnecting is one click.
export async function clearTokens(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "gsp_connection" SET
      "oauth_access_token_encrypted" = NULL,
      "oauth_refresh_token_encrypted" = NULL,
      "oauth_token_expires_at" = NULL,
      "google_account_email" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

export async function setSpreadsheet(opts: { spreadsheetId: string; spreadsheetUrl: string }): Promise<void> {
  await ensureRow()
  await prisma.$executeRaw`
    UPDATE "gsp_connection" SET
      "spreadsheet_id" = ${opts.spreadsheetId},
      "spreadsheet_url" = ${opts.spreadsheetUrl},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

export async function stampLastPush(): Promise<void> {
  await prisma.$executeRaw`UPDATE "gsp_connection" SET "last_push_at" = CURRENT_TIMESTAMP WHERE "id" = ${SINGLETON}`
}

// Bumped after each tab a Push writes. Feeds the edit-guard (see push route) so a
// half-failed push does not read its own write back as an owner edit, while
// leaving last_push_at (the deletion baseline) for full-success only.
export async function stampLastPushAttempt(): Promise<void> {
  await prisma.$executeRaw`UPDATE "gsp_connection" SET "last_push_attempt_at" = CURRENT_TIMESTAMP WHERE "id" = ${SINGLETON}`
}

// The old synchronous Push held a connection-level lease here (push_lock_until) so
// two overlapping Pushes could not interleave. A Push is now a resumable job, and
// concurrency is handled by the job's own step lease plus the partial unique index
// that allows one RUNNING gsp_push_job at a time - so that lease is gone. The
// push_lock_until column is left in place (harmless, no migration needed).

export async function stampLastPull(): Promise<void> {
  await prisma.$executeRaw`UPDATE "gsp_connection" SET "last_pull_at" = CURRENT_TIMESTAMP WHERE "id" = ${SINGLETON}`
}

// Record which variation tabs the Push just wrote, so the Pull can refuse when one
// has since been renamed or deleted (see lib/variation-tabs.ts). Written once, at
// the end of a successful Push, replacing the previous manifest wholesale. Each
// entry also carries the pushed grid's fingerprint so the NEXT Push can skip a
// tab whose content has not moved (see lib/push-run.ts).
export async function setVariationTabManifest(manifest: Array<{ slug: string; title: string; hash?: string }>): Promise<void> {
  await ensureRow()
  await prisma.$executeRaw`
    UPDATE "gsp_connection" SET "variation_tab_manifest" = ${JSON.stringify(manifest)}::jsonb, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}
