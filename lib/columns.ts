import type { CsvColumn } from '@/modules/shop/lib/csv'
import type { GspConnection } from '@/modules/google-sheet-products-for-shop/lib/types'

// Which optional catalogue columns the sheet carries.
//
// Cost price is NOT one of these: the owner asked for it to go every time rather
// than sit behind a switch (see push-products.ts). Stock and trade price are the
// two figures an owner may not want in a file they hand round, and neither is
// needed to identify or price a product, so both can be left out entirely.
//
// "Left out" means left out of the PUSH, and that is the whole mechanism. A
// column absent from the sheet is not compared by the Pull diff and its field is
// left alone by both importers - so switching one off stops it syncing in both
// directions, without a single special case anywhere in the pipeline.

export type ColumnPrefs = {
  includeStock: boolean
  includeTradePrice: boolean
}

// What an install that has never touched the setting gets, and what the Push
// falls back to if the connection row is somehow missing: everything included,
// which is exactly how the sheet behaved before the switches existed.
export const DEFAULT_COLUMN_PREFS: ColumnPrefs = { includeStock: true, includeTradePrice: true }

export function columnPrefsFrom(conn: Pick<GspConnection, 'includeStock' | 'includeTradePrice'> | null): ColumnPrefs {
  if (!conn) return DEFAULT_COLUMN_PREFS
  return { includeStock: conn.includeStock, includeTradePrice: conn.includeTradePrice }
}

// The Products-tab columns to leave out. Stock is the count only - the
// track_inventory flag, the low-stock threshold and the out-of-stock behaviour
// are settings rather than figures, and stay put.
export function excludedProductColumns(prefs: ColumnPrefs): CsvColumn[] {
  const out: CsvColumn[] = []
  if (!prefs.includeStock) out.push('stock_count')
  if (!prefs.includeTradePrice) out.push('trade_price')
  return out
}

// The same two columns as each product's variation tab labels them.
export function excludedVariationColumns(prefs: ColumnPrefs): string[] {
  const out: string[] = []
  if (!prefs.includeStock) out.push('Stock')
  if (!prefs.includeTradePrice) out.push('Trade Price')
  return out
}
