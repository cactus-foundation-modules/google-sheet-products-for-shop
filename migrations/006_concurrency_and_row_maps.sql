-- Google Sheet Products for Shop — pull concurrency guard + sheet-row maps
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- (a) At most one RUNNING pull job at a time.
--
-- The "only one Pull" guard in the start route was a SELECT followed - after two
-- sheet reads and a full diff, 10s+ later - by an INSERT, with nothing enforcing
-- it in between. A double-click or two tabs let both requests pass the check and
-- create two RUNNING jobs, which then ran the same shifting catalogue twice over
-- (SKU-less rows created twice with `-2` slugs, the deletion plan replayed).
--
-- A partial unique index on ("status") WHERE status = 'RUNNING' allows exactly
-- one RUNNING row (every qualifying row shares the same status value, so the
-- second INSERT collides). The start route catches the violation and returns 409.
-- FAILED jobs (which the Continue prompt also treats as unfinished) are outside
-- this index and stay caught by the app-level check.
-- ---------------------------------------------------------------------------

-- Collapse any pre-existing duplicate RUNNING rows (a race before this index
-- existed) so the unique index can be built. Keeps the newest, fails the rest.
UPDATE "gsp_pull_job" SET "status" = 'FAILED', "error" = COALESCE("error", 'Superseded by a newer pull')
WHERE "status" = 'RUNNING' AND "id" <> (
    SELECT "id" FROM "gsp_pull_job" WHERE "status" = 'RUNNING' ORDER BY "created_at" DESC LIMIT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "gsp_pull_job_one_running"
    ON "gsp_pull_job" ("status") WHERE "status" = 'RUNNING';

-- ---------------------------------------------------------------------------
-- (b) Original 1-based sheet row number for each kept data row.
--
-- The stored grids hold only the rows the start-of-pull diff could not prove
-- unchanged, so an index into them is not the row the owner sees in their sheet.
-- These maps carry each kept row's true sheet row number, so every row error a
-- Pull reports points at the right place. Null on jobs created before this
-- column existed (their errors fall back to the filtered index, as before).
-- ---------------------------------------------------------------------------

ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "products_row_map" JSONB;
ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "variations_row_map" JSONB;

-- ---------------------------------------------------------------------------
-- (c) Push edit-guard timestamp, separate from the deletion baseline.
--
-- The "sheet has been edited since we synced" guard compared Drive's modifiedTime
-- against last_push_at. But a Push that wrote the Products tab and then failed on
-- the Variations tab bumped modifiedTime WITHOUT stamping last_push_at (that only
-- happens on full success, because it doubles as the deletion baseline). The
-- retry then saw its own half-write as an owner edit and demanded a force. This
-- timestamp is stamped after every tab a Push writes, so the guard tracks our own
-- writes without corrupting the deletion baseline.
-- ---------------------------------------------------------------------------
ALTER TABLE "gsp_connection" ADD COLUMN IF NOT EXISTS "last_push_attempt_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- (d) Push mutex. A Push holds this short lease while it runs so a second Push
-- (a double-submit) cannot interleave its read/write/clear/restore with the
-- first and corrupt the tab. Self-clearing via an expiry, like the pull lease.
-- ---------------------------------------------------------------------------
ALTER TABLE "gsp_connection" ADD COLUMN IF NOT EXISTS "push_lock_until" TIMESTAMP(3);
