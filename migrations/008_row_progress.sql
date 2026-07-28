-- Google Sheet Products for Shop — per-row progress on a running Pull
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- A Pull used to report progress only at chunk boundaries: 25 products, or one
-- whole parent's variations, at a time. The owner watched a number sit still for
-- seconds and had no idea which product it was on. Both importers now announce
-- each row as they pick it up, and these three columns carry that commentary to
-- the browser, which polls the job row.
--
-- They are display only, and deliberately NOT the resume cursor. The variations
-- importer flushes a parent's field writes together at the end of the group, so
-- advancing products_done / variations_done mid-chunk would let a killed step
-- resume past rows that were never written. current_offset counts rows inside
-- the chunk in flight and is reset to zero every time the real cursor is banked.
-- ---------------------------------------------------------------------------

ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "current_item" TEXT;
ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "current_offset" INTEGER NOT NULL DEFAULT 0;
-- The last handful of rows that went through, newest first, as a JSON array of
-- strings. Capped by the writer so a 600-row Pull cannot grow this without end.
ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "recent_items" JSONB;
