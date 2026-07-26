-- Google Sheet Products for Shop — Push job (resumable, per-product-tab Push)
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- Variations no longer mirror into ONE wide "Variations" tab. Every variable
-- product now gets its OWN tab, carrying only the option columns it actually
-- uses. A catalogue with dozens of variable products therefore means dozens of
-- tab writes per Push — far past the handful the old synchronous push made, and
-- past both the module dispatcher's 60s ceiling and Google's per-minute write
-- quota. So a Push is now a resumable job the admin's browser drives one bounded
-- batch of tabs at a time, exactly like a Pull (see 002_pull_job.sql): each
-- /push/step writes a few tabs, advances the cursor here, and returns live
-- counts. Closing the tab or a failed step just leaves the job at its cursor; a
-- Continue resumes from there. Every step is idempotent (a tab re-written from
-- the same snapshot lands the same cells, formula preservation and all).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsp_push_job" (
    "id"                 TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "status"             TEXT         NOT NULL DEFAULT 'RUNNING',  -- RUNNING | COMPLETED | FAILED | CANCELLED
    "phase"              TEXT         NOT NULL DEFAULT 'PRODUCTS', -- PRODUCTS | VARIATION_TABS | CLEANUP | DONE
    -- The owner confirmed overwriting a sheet edited since the last sync. Carried
    -- on the job so a resumed step does not re-trigger the edit guard.
    "force"              BOOLEAN      NOT NULL DEFAULT false,
    -- Snapshots built once at start, so a multi-step Push writes one stable view
    -- of the catalogue even if the admin edits a product mid-run. Nulled out once
    -- the job finishes, so a completed row does not carry the whole catalogue.
    -- products_grid: the Products tab grid (header + rows).
    -- variation_tabs: [{ slug, name, title, grid }] — one per variable product.
    "products_grid"      JSONB,
    "variation_tabs"     JSONB,
    -- Titles of the variation tabs written so far, so the CLEANUP phase can delete
    -- exactly the tabs that belong to no current product (a product that stopped
    -- being variable, or a tab the owner renamed) without touching the owner's own
    -- tabs. Accumulated across steps.
    "written_titles"     JSONB,
    "tabs_total"         INTEGER      NOT NULL DEFAULT 0,  -- variable products to write
    "tabs_done"          INTEGER      NOT NULL DEFAULT 0,  -- tabs written so far; doubles as the resume cursor
    -- Result counts, accumulated across batches, written to gsp_sync_log at the end.
    "products_rows"      INTEGER      NOT NULL DEFAULT 0,
    "variations_rows"    INTEGER      NOT NULL DEFAULT 0,
    "suppliers_rows"     INTEGER      NOT NULL DEFAULT 0,
    "formulas_kept"      INTEGER      NOT NULL DEFAULT 0,
    "error"              TEXT,                              -- fatal message when status = FAILED
    "run_by"             TEXT,                              -- admin user id, no FK (core table)
    -- Step lease: the id of the worker currently stepping the job is not needed,
    -- only that SOMEONE holds it until this time. A killed step's lease simply
    -- expires and the next Continue takes over. See pull-run.ts withPullStepLock.
    "step_lease_until"   TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsp_push_job_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "gsp_push_job"
        ADD CONSTRAINT "gsp_push_job_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "gsp_push_job"
        ADD CONSTRAINT "gsp_push_job_phase_check" CHECK ("phase" IN ('PRODUCTS', 'VARIATION_TABS', 'CLEANUP', 'DONE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The Continue prompt on load asks for the most recent unfinished job.
CREATE INDEX IF NOT EXISTS "gsp_push_job_status_created_idx" ON "gsp_push_job" ("status", "created_at" DESC);

-- At most one live Push at a time. Two starts that race past the app-level check
-- (a double-click, two admin tabs) both try to insert a RUNNING row; the second
-- trips this and is turned into a 409 "a push is already running".
CREATE UNIQUE INDEX IF NOT EXISTS "gsp_push_job_one_running"
    ON "gsp_push_job" ((1)) WHERE "status" = 'RUNNING';

-- ---------------------------------------------------------------------------
-- Pull safety: the manifest of variation tabs the last Push wrote.
--
-- With one tab per product, a Pull reads EVERY variation tab and merges them. If
-- the owner has renamed or deleted a product's tab since the Push, that product's
-- variants simply would not be found — and a naive merge would read them as
-- "removed from the sheet" and DELETE them from the shop. To prevent that, the
-- Push records the slug of every product tab it wrote here; the Pull refuses to
-- run when a recorded slug is nowhere in the sheet, telling the owner which tab
-- to restore. Shape: [{ "slug": "...", "title": "..." }].
-- ---------------------------------------------------------------------------
ALTER TABLE "gsp_connection" ADD COLUMN IF NOT EXISTS "variation_tab_manifest" JSONB;
