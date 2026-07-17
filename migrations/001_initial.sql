-- Google Sheet Products for Shop — Initial Migration
-- Table prefix: gsp_
-- Applied once by the Cactus module migration runner during build.
-- Hard-depends on the shop + shop-variations modules being installed first.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- Single-row connection config. Mirrors rc_mailbox_config's shape and naming.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsp_connection" (
    "id"                             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "oauth_client_id_encrypted"      TEXT,
    "oauth_client_secret_encrypted"  TEXT,
    "oauth_access_token_encrypted"   TEXT,
    "oauth_refresh_token_encrypted"  TEXT,
    "oauth_token_expires_at"         TIMESTAMP(3),
    "google_account_email"           TEXT,          -- display only: "connected as ..."
    "spreadsheet_id"                 TEXT,
    "spreadsheet_url"                TEXT,
    "include_cost_price"             BOOLEAN      NOT NULL DEFAULT true,
    "last_push_at"                   TIMESTAMP(3),  -- staleness guard
    "last_pull_at"                   TIMESTAMP(3),
    "created_at"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsp_connection_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Audit trail. Every push and pull, with counts and per-row errors.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsp_sync_log" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "direction"       TEXT         NOT NULL,
    "tab"             TEXT         NOT NULL,
    "status"          TEXT         NOT NULL,
    "created_count"   INTEGER      NOT NULL DEFAULT 0,
    "updated_count"   INTEGER      NOT NULL DEFAULT 0,
    "skipped_count"   INTEGER      NOT NULL DEFAULT 0,
    "archived_count"  INTEGER      NOT NULL DEFAULT 0,
    "errors"          JSONB,
    "run_by"          TEXT,                         -- admin user id, no FK (core table)
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsp_sync_log_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "gsp_sync_log"
        ADD CONSTRAINT "gsp_sync_log_direction_check" CHECK ("direction" IN ('PUSH', 'PULL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "gsp_sync_log"
        ADD CONSTRAINT "gsp_sync_log_tab_check" CHECK ("tab" IN ('PRODUCTS', 'VARIATIONS'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "gsp_sync_log"
        ADD CONSTRAINT "gsp_sync_log_status_check" CHECK ("status" IN ('COMPLETED', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "gsp_sync_log_created_at_idx" ON "gsp_sync_log" ("created_at" DESC);
