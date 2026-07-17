import { getProductBySlug, deleteProduct } from '@/modules/shop/lib/db/products'
import { getEditorPayload } from '@/modules/shop-variations/lib/variants-service'
import type { SyncRowError } from '@/modules/google-sheet-products-for-shop/lib/types'

// A variant is identified by its unordered set of option-value ids.
function comboKey(optionValueIds: string[]): string {
  return [...optionValueIds].sort().join('|')
}

// Decision (variations, unlike products): a row deleted from the Variations tab
// IS a delete. A product removed from the sheet is only ever archived (order
// history, reversible), but a variant that has left the sheet is pruned outright
// - deleting its hidden child product cascades the svr_ rows away, the same path
// the matrix builder and "clear variants" already use.
//
// Scope is deliberately narrow: we only prune inside a parent that STILL has at
// least one row in the Variations grid. A parent the owner simply left out of the
// sheet entirely is never emptied by accident - that is treated as "not synced",
// not "delete everything". Runs AFTER importVariationsCsv, so any option/value a
// kept row introduced already exists before we work out what is unwanted.
export async function reconcileVariations(grid: string[][]): Promise<{ deleted: number; errors: SyncRowError[] }> {
  const errors: SyncRowError[] = []
  let deleted = 0
  if (grid.length < 2) return { deleted, errors }

  const header = (grid[0] ?? []).map((h) => h.trim())
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const slugCol = idx('Parent Slug')
  if (slugCol < 0) return { deleted, errors } // no parent column -> nothing addressable

  const optionPairs: Array<{ nameCol: number; valueCol: number }> = []
  for (let i = 1; ; i++) {
    const nameCol = idx(`Option ${i}`)
    const valueCol = idx(`Value ${i}`)
    if (nameCol < 0 || valueCol < 0) break
    optionPairs.push({ nameCol, valueCol })
  }

  // Group the sheet's rows by parent slug (only parents present here are in scope).
  const groups = new Map<string, string[][]>()
  for (let r = 1; r < grid.length; r++) {
    const cols = grid[r] ?? []
    const slug = (cols[slugCol] ?? '').trim()
    if (!slug) continue
    const list = groups.get(slug) ?? []
    list.push(cols)
    groups.set(slug, list)
  }

  for (const [slug, rows] of groups) {
    const parent = await getProductBySlug(slug)
    if (!parent || parent.catalogueHidden) continue

    const payload = await getEditorPayload(parent.id)
    if (!payload) continue

    // Map (optionName|valueLabel) -> value id so the sheet's labels can be turned
    // into the same id-set the stored variants are keyed by.
    const valueIdByKey = new Map<string, string>()
    for (const o of payload.options) for (const v of o.values) valueIdByKey.set(`${o.name.toLowerCase()}|${v.label.toLowerCase()}`, v.id)

    // Every combination the sheet still wants for this parent.
    const wanted = new Set<string>()
    for (const cols of rows) {
      const ids: string[] = []
      let resolvable = true
      for (const pair of optionPairs) {
        const optName = (cols[pair.nameCol] ?? '').trim()
        const valLabel = (cols[pair.valueCol] ?? '').trim()
        if (!optName || !valLabel) continue
        const id = valueIdByKey.get(`${optName.toLowerCase()}|${valLabel.toLowerCase()}`)
        if (!id) { resolvable = false; break }
        ids.push(id)
      }
      if (resolvable && ids.length) wanted.add(comboKey(ids))
    }

    // Any stored variant whose combination is no longer wanted gets pruned.
    for (const v of payload.variants) {
      if (v.optionValueIds.length === 0) continue
      if (wanted.has(comboKey(v.optionValueIds))) continue
      try {
        await deleteProduct(v.childProductId)
        deleted += 1
      } catch (err) {
        errors.push({ row: 0, reason: `Could not remove variant "${v.label}" of ${slug}: ${err instanceof Error ? err.message : 'unknown error'}` })
      }
    }
  }

  return { deleted, errors }
}
