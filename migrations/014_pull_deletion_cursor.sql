-- Google Sheet Products for Shop — 014: the removals phase gets a cursor
--
-- The DELETIONS phase applied the whole plan in two statements - one DELETE for
-- every departing product, one for every departing variant - with no time budget
-- and nothing to resume from. Two statements is not the same as quick: deleting a
-- product cascades through its media, its categories, its variants, its variant
-- values and every module's per-product rows, so a plan of a few thousand is real
-- work. Past the module dispatcher's sixty-second ceiling the platform kills the
-- request mid-statement, the step retries from the beginning, and the Pull sits on
-- "Removing items no longer in the sheet…" for ever - the same shape of stall the
-- products phase had before it was chunked.
--
-- So the phase now works in bounded chunks and banks how far it has got, exactly
-- like the products and variations phases either side of it. Both counters index
-- into the stored deletion_plan, which is fixed at the moment the check ran, so a
-- resumed step picks up at the same entry it was on.
--
-- Idempotent: safe on fresh installs and re-runs.

ALTER TABLE "gsp_pull_job"
    ADD COLUMN IF NOT EXISTS "prod_deletions_done" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "gsp_pull_job"
    ADD COLUMN IF NOT EXISTS "var_deletions_done" INTEGER NOT NULL DEFAULT 0;
