-- Google Sheet Products for Shop — stored deletion plan on the Pull job
-- Applied by the Cactus module migration runner during build. Idempotent.

-- A Pull now diffs the sheet against the shop at start and stores only the rows
-- that actually changed (plus creates and error rows) in products_grid /
-- variations_grid, so the importers never grind through rows that would write
-- nothing. The deletion side, however, must be planned against the FULL sheet
-- snapshot — a filtered grid would read every skipped row as "gone from the
-- sheet" and delete the lot. So the plan is computed once at start, from the
-- full grids, and stored here; the DELETIONS phase applies exactly this list.
-- Nulled alongside the grids when the job finishes. A job created before this
-- column existed carries NULL, and the runner falls back to planning from its
-- (then unfiltered) stored grids, exactly as before.
ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "deletion_plan" JSONB;
