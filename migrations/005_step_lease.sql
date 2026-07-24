-- Google Sheet Products for Shop — step lease for pooled connections
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- The per-job step lock used to be a transaction-scoped advisory lock held for
-- the whole step (up to the dispatcher's 60s ceiling). On an install whose
-- DATABASE_URL runs through a pooler with connection_limit=1, that transaction
-- owned the pool's only connection while every query inside the step asked the
-- pool for another - a 20-second wait, then "Timed out fetching a new
-- connection from the connection pool", on every step, forever.
--
-- The lock is now a lease on the job row itself, claimed and released with
-- single-statement UPDATEs that hold no connection between them. A step the
-- platform kills never releases, so the lease carries its own expiry: longer
-- than any single request can live, after which the next Continue claims it.
-- ---------------------------------------------------------------------------

ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "step_lease_until" TIMESTAMP(3);
