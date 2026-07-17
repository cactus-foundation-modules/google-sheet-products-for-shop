import { importVariationsCsv, type ImportResult } from '@/modules/shop-variations/lib/csv'
import { gridToImportCsv } from '@/modules/google-sheet-products-for-shop/lib/pull-products'

// Sheet grid -> shop-variations' importer. importVariationsCsv groups rows by
// parent slug, auto-creates any option/value it hasn't seen, and matches variants
// by exact value-set, so it round-trips. It returns counts synchronously - no
// job row needed. Parents must already exist (the importer will not create them),
// which is why Products is always pulled first.
export async function pullVariations(grid: string[][]): Promise<ImportResult> {
  return importVariationsCsv(gridToImportCsv(grid))
}
