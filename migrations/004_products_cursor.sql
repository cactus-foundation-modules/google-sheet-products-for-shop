-- Google Sheet Products for Shop — products cursor for the chunked PRODUCTS phase
-- Table prefix: gsp_
-- Applied by the Cactus module migration runner during build.
-- Idempotent throughout (fresh installs and re-runs are both safe).

-- ---------------------------------------------------------------------------
-- The PRODUCTS phase used to feed the whole filtered grid through shop's import
-- engine in ONE /pull/step call. A big enough changed-row count blew the module
-- dispatcher's 60s ceiling: the platform killed the request before the phase
-- could advance, the browser stepped again, the import restarted from row one,
-- and the Pull sat on "Updating products…" forever. Products now run in bounded
-- chunks exactly like variations, and this column is their resume cursor: rows
-- fed to the importer so far, advanced after every chunk.
-- ---------------------------------------------------------------------------

ALTER TABLE "gsp_pull_job" ADD COLUMN IF NOT EXISTS "products_done" INTEGER NOT NULL DEFAULT 0;
