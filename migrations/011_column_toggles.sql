-- Google Sheet Products for Shop — 011: optional catalogue columns
--
-- Two columns the owner can now keep out of the sheet entirely: the stock count
-- (stock_count on Products, "Stock" on each product's variation tab) and the
-- trade price (trade_price / "Trade Price"). Both default to true, so an existing
-- install's sheet is unchanged until the owner switches one off.
--
-- Switching one off drops the column from the next Push; a Pull then simply does
-- not sync that field, exactly as it already treats any column the sheet is
-- missing (the importers leave an absent column's field alone).
--
-- Idempotent: safe on fresh installs and re-runs.

ALTER TABLE "gsp_connection"
    ADD COLUMN IF NOT EXISTS "include_stock" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "gsp_connection"
    ADD COLUMN IF NOT EXISTS "include_trade_price" BOOLEAN NOT NULL DEFAULT true;
