<p align="center">
  <img src="module-art.webp" alt="Google Sheet Products for Shop" width="640" />
</p>

# Google Sheet Products for Shop

Mirrors your Cactus Shop catalogue into a Google Sheet you can bulk-edit, then
pulls the changes back in. Handy for the jobs a product form is simply bad at:
re-pricing three hundred lines, fixing a supplier's spelling everywhere at once,
or handing the catalogue to someone who only knows spreadsheets.

- **Table prefix:** `gsp_`
- **Depends on:** the `shop` module (`>= 0.1.248`) and `shop-variations` (`>= 0.1.150`)
- **Permission:** `googlesheets.manage`

## How it works

1. Connect a Google account and pick (or create) a sheet on
   **Settings → Shop → Google Sheet**.
2. **Push** writes the catalogue out - products on one tab, variations on
   another, one row per record.
3. Edit in the sheet. Add rows, change prices, correct names.
4. **Pull** reads it back, shows you a preview of exactly what will change, and
   applies it once you say so.

Both directions run as background jobs, so a large catalogue does not have to
finish inside a single request.

> **Match variations by their Variant ID, never by SKU.** A Pull can return the
> SKU column in a different order than it went out. The Variant ID is the only
> column that identifies a row for certain.

## Configuration

| Variable | Purpose |
|----------|---------|
| `ENCRYPTION_KEY` | Required. Encrypts the stored Google credentials. |
| `SITE_URL` | Required. Used to build the OAuth redirect. |
| `GSP_SHEETS_READS_PER_MINUTE` | Optional. Throttles reads against the Sheets API quota. |
| `GSP_SHEETS_WRITES_PER_MINUTE` | Optional. Throttles writes. |

Part of [Cactus](https://github.com/usersaynoso/cactus-foundation). Install it
from **Modules → Browse** in the admin.
