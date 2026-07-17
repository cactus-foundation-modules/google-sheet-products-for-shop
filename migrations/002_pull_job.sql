-- Google Sheet Products for Shop — Pull job (resumable, live-progress Pull)
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- A Pull no longer runs to completion inside one request's after() (capped at
-- the module dispatcher's 60s ceiling — a big catalogue died mid-variations and
-- left them half-written). Instead a Pull is a resumable job the admin's browser
-- drives one bounded batch at a time: each /pull/step call does a slice of work,
-- advances the cursor stored here, and returns live counts. Closing the tab or a
-- failed step just leaves the job at its cursor; a Continue resumes from there.
-- Every batch is idempotent (products match by SKU/slug, variations upsert by
-- value-set, deletes are by-id no-ops once gone), so replaying a batch is safe.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsp_pull_job" (
    "id"                   TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "status"               TEXT         NOT NULL DEFAULT 'RUNNING',  -- RUNNING | COMPLETED | FAILED | CANCELLED
    "phase"                TEXT         NOT NULL DEFAULT 'PRODUCTS', -- PRODUCTS | DELETIONS | VARIATIONS | DONE
    -- Sheet snapshots taken at start, so a multi-step Pull works off one stable
    -- view even if the sheet is edited mid-run. Nulled out once the job finishes,
    -- so a completed row does not carry the whole catalogue around.
    "products_grid"        JSONB,
    "variations_grid"      JSONB,
    -- Deletion baseline captured at start (the connection's last_push_at). Kept on
    -- the job so every DELETIONS re-run plans against the same anchor.
    "last_push_at"         TIMESTAMP(3),
    -- The shp_import_jobs row that carries the products phase. Its processed_rows
    -- is what the status endpoint reads for live "X of Y products" progress.
    "shop_import_job_id"   TEXT,
    -- The preview summary the confirm dialog showed, for display only (e.g. when a
    -- Continue is resumed on a fresh page load with no preview in hand).
    "detected"             JSONB,
    "products_total"       INTEGER      NOT NULL DEFAULT 0,
    "variations_total"     INTEGER      NOT NULL DEFAULT 0,  -- variation data rows
    "variations_done"      INTEGER      NOT NULL DEFAULT 0,  -- rows fed to the importer so far; doubles as the resume cursor
    -- Result counts, accumulated across batches, written to gsp_sync_log at the end.
    "prod_created"         INTEGER      NOT NULL DEFAULT 0,
    "prod_updated"         INTEGER      NOT NULL DEFAULT 0,
    "prod_skipped"         INTEGER      NOT NULL DEFAULT 0,
    "prod_deleted"         INTEGER      NOT NULL DEFAULT 0,
    "var_created"          INTEGER      NOT NULL DEFAULT 0,
    "var_updated"          INTEGER      NOT NULL DEFAULT 0,
    "var_deleted"          INTEGER      NOT NULL DEFAULT 0,
    "prod_errors"          JSONB,
    "var_errors"           JSONB,
    "error"                TEXT,                              -- fatal message when status = FAILED
    "run_by"               TEXT,                              -- admin user id, no FK (core table)
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsp_pull_job_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "gsp_pull_job"
        ADD CONSTRAINT "gsp_pull_job_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "gsp_pull_job"
        ADD CONSTRAINT "gsp_pull_job_phase_check" CHECK ("phase" IN ('PRODUCTS', 'DELETIONS', 'VARIATIONS', 'DONE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One quick lookup: the most recent unfinished job, for the Continue prompt.
CREATE INDEX IF NOT EXISTS "gsp_pull_job_status_created_idx" ON "gsp_pull_job" ("status", "created_at" DESC);
