-- Google Sheet Products for Shop — 012: the Pull preview is a resumable job
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- "Reading your sheet and comparing it with your catalogue…" used to be ONE
-- request. On a catalogue of any size that request had to, inside the module
-- dispatcher's sixty-second ceiling:
--
--   * ask Drive for the sheet's modified time,
--   * list every tab, read every tab's header row, then read the body of every
--     product tab (a few dozen batched calls on a several-hundred-tab workbook),
--   * build the whole catalogue's CSV view,
--   * diff every Products row against it,
--   * plan every deletion (which loads every variable parent's variants),
--   * diff every variation row (which loads them all over again, plus one
--     preload per parent per contributing module).
--
-- Past a few hundred products that is minutes of work, so the platform killed
-- the request and the dialog sat on its loading line for ever. Worse, pressing
-- Pull then did the WHOLE lot a second time before a single row was imported.
--
-- So the preview is now a job the browser drives one bounded step at a time,
-- exactly like the Pull and the Push (see 002 and 007): each /pull/preview/step
-- does as much as it can inside its own time budget, banks its cursor here, and
-- returns live progress. Nothing is written to the catalogue at any point - a
-- preview is still strictly read-only.
--
-- And because the finished job carries the filtered grids, the row maps and the
-- deletion plan, POST /pull now just adopts them: the second full sweep is gone.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "gsp_preview_job" (
    "id"                    TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "status"                TEXT         NOT NULL DEFAULT 'RUNNING',  -- RUNNING | COMPLETED | FAILED | CANCELLED
    "phase"                 TEXT         NOT NULL DEFAULT 'READ',     -- READ | PRODUCTS | DELETIONS | VARIATIONS | DONE

    -- --- READ phase -------------------------------------------------------
    -- The variation tabs still to read, and how far through them we are. Tabs
    -- are classified once (header row carries "Parent Slug") and then read in
    -- batched groups, so the cursor is a tab index, not a call count.
    "tab_titles"            JSONB,
    "tabs_total"            INTEGER      NOT NULL DEFAULT 0,
    "tabs_done"             INTEGER      NOT NULL DEFAULT 0,
    -- Per-tab grids as they come back, merged into variations_grid once the last
    -- one lands (the merge needs every tab to work out the superset header).
    "raw_tabs"              JSONB,
    -- Drive's modifiedTime, read BEFORE the grids so a sheet edited mid-read
    -- files its snapshot under the older instant and is simply not reused.
    "drive_modified_time"   TIMESTAMP(3),
    "products_grid"         JSONB,
    "variations_grid"       JSONB,

    -- --- comparison cursors ----------------------------------------------
    -- Products are counted in sheet rows; variations in PARENT GROUPS, because a
    -- parent's rows are diffed together (its options and variants load once).
    "products_total"        INTEGER      NOT NULL DEFAULT 0,
    "products_done"         INTEGER      NOT NULL DEFAULT 0,
    "variations_total"      INTEGER      NOT NULL DEFAULT 0,
    "variations_done"       INTEGER      NOT NULL DEFAULT 0,
    -- The row (or product) being compared right now, for the dialog's commentary.
    "current_item"          TEXT,

    -- --- accumulated result ----------------------------------------------
    -- The PullPreview the dialog renders, built up phase by phase. Its lists are
    -- capped (with totals kept alongside) so a catalogue-wide change cannot make
    -- this row - or the response - unbounded.
    "preview"               JSONB,
    -- Exactly what a Pull started from this preview needs, so it never has to
    -- read or diff anything again: the rows with work in them, each one's
    -- original sheet row, the deletion plan and the headline counts.
    "filtered_products"     JSONB,
    "products_row_map"      JSONB,
    "filtered_variations"   JSONB,
    "variations_row_map"    JSONB,
    "deletion_plan"         JSONB,
    "detected"              JSONB,
    -- The deletion baseline this preview was planned against. A Pull adopting it
    -- stores the same one, so what the dialog listed is what gets removed.
    "last_push_at"          TIMESTAMP(3),

    "error"                 TEXT,
    -- Some failures are worth retrying (a database blip, a killed request) and
    -- some never will be: a renamed product tab, a workbook with no product tabs
    -- at all. The browser retries a failed step five times before it gives up, so
    -- a settled answer flagged here stops that loop at once and the owner reads
    -- what to do instead of watching half a minute of pointless retries.
    "fatal"                 BOOLEAN      NOT NULL DEFAULT false,
    "run_by"                TEXT,
    -- Step lease, same shape and reasoning as the Pull's: a killed step's lease
    -- expires and the next step takes over. See lib/preview-run.ts.
    "step_lease_until"      TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsp_preview_job_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "gsp_preview_job"
        ADD CONSTRAINT "gsp_preview_job_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "gsp_preview_job"
        ADD CONSTRAINT "gsp_preview_job_phase_check" CHECK ("phase" IN ('READ', 'PRODUCTS', 'DELETIONS', 'VARIATIONS', 'DONE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reopening the dialog asks for the most recent job, finished or not: a finished
-- one is the preview to show, an unfinished one is a check to carry on with.
CREATE INDEX IF NOT EXISTS "gsp_preview_job_created_idx" ON "gsp_preview_job" ("created_at" DESC);

-- At most one live check at a time. Two starts that race past the app-level
-- check (a double-click, two admin tabs) both try to insert a RUNNING row; the
-- second trips this and is handed the first one's id instead.
CREATE UNIQUE INDEX IF NOT EXISTS "gsp_preview_job_one_running"
    ON "gsp_preview_job" ((1)) WHERE "status" = 'RUNNING';
