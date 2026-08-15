-- Google Sheet Products for Shop — 013: the Push builds its snapshot in steps
--
-- POST /push used to build the ENTIRE catalogue snapshot before it answered: the
-- Products grid (every product's categories, tags, collections and media) and one
-- narrow grid per variable product (every parent's options, variants and every
-- contributing module's per-variant values). On a big catalogue that is most of a
-- minute of database work with nothing on screen but "Starting the push…", and
-- past the module dispatcher's sixty-second ceiling it never answered at all.
--
-- The job row is now created empty, and the snapshot is built by the first two
-- steps instead - so the dialog appears at once and says what it is doing. Two
-- phases rather than one because each half is heavy in its own right:
--
--   BUILD_PRODUCTS - the Products tab grid
--   BUILD_TABS     - one grid per variable product
--
-- Both write into the same products_grid / variation_tabs columns 007 created, so
-- everything downstream is unchanged. Idempotent: safe on fresh installs and
-- re-runs.

-- The phase CHECK from 007 does not know the two new names. Replace it rather
-- than adding a second (a row must satisfy every CHECK on the table).
ALTER TABLE "gsp_push_job" DROP CONSTRAINT IF EXISTS "gsp_push_job_phase_check";

DO $$ BEGIN
    ALTER TABLE "gsp_push_job"
        ADD CONSTRAINT "gsp_push_job_phase_check"
        CHECK ("phase" IN ('BUILD_PRODUCTS', 'BUILD_TABS', 'PRODUCTS', 'VARIATION_TABS', 'CLEANUP', 'DONE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A push started before this migration is mid-flight in one of the old phases,
-- which are all still valid, so nothing needs converting.

-- New pushes start at BUILD_PRODUCTS. The column default still says 'PRODUCTS';
-- the insert names the phase explicitly, so the default only ever applies to a
-- row written by hand. Moved anyway so the two agree.
ALTER TABLE "gsp_push_job" ALTER COLUMN "phase" SET DEFAULT 'BUILD_PRODUCTS';
