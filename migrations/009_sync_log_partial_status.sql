-- ---------------------------------------------------------------------------
-- A Pull whose rows errored used to be logged as a plain COMPLETED, so the
-- owner never learned any rows were rejected. The audit log now records such a
-- run as COMPLETED_WITH_ERRORS; widen the status check to allow it.
-- Drop-then-add is idempotent as a pair, so a re-run is harmless.
-- ---------------------------------------------------------------------------

ALTER TABLE "gsp_sync_log" DROP CONSTRAINT IF EXISTS "gsp_sync_log_status_check";

DO $$ BEGIN
    ALTER TABLE "gsp_sync_log"
        ADD CONSTRAINT "gsp_sync_log_status_check" CHECK ("status" IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
