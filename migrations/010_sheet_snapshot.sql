-- Google Sheet Products for Shop — sheet snapshot for preview→pull reuse
--
-- A preview reads the Products tab and every variation tab, then the Pull the
-- owner starts seconds later reads the identical grids all over again — the
-- second sweep exists only so a stale preview can never start a pull against a
-- sheet that has moved on. This table keeps the preview's snapshot alongside the
-- sheet's Drive modifiedTime at the moment it was read; the Pull re-fetches
-- modifiedTime (one cheap Drive call) and reuses the snapshot only when the two
-- match EXACTLY — any edit, or any Push, bumps modifiedTime and the Pull reads
-- fresh as before. The diff against the catalogue is always recomputed either
-- way; only the Google reads are saved.
--
-- Single row, keyed 'singleton' like gsp_connection. Overwritten on every
-- preview, cleared never (a stale row is harmless — its modifiedTime no longer
-- matches anything).
-- Idempotent (fresh installs and re-runs are both safe).

CREATE TABLE IF NOT EXISTS "gsp_sheet_snapshot" (
    "id"                   TEXT         NOT NULL,
    "products_grid"        JSONB        NOT NULL,
    "variations_grid"      JSONB        NOT NULL,
    "drive_modified_time"  TIMESTAMP(3) NOT NULL,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gsp_sheet_snapshot_pkey" PRIMARY KEY ("id")
);
