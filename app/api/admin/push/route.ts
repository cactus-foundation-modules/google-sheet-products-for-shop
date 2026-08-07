import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { createPushJob, getLatestUnfinishedPushJob, PushAlreadyRunningError } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { pushStatus } from '@/modules/google-sheet-products-for-shop/lib/push-run'
import { buildProductsGrid } from '@/modules/google-sheet-products-for-shop/lib/push-products'
import { buildVariationTabs } from '@/modules/google-sheet-products-for-shop/lib/push-variations'
import { columnPrefsFrom } from '@/modules/google-sheet-products-for-shop/lib/columns'
import { productTabTitle, RESERVED_TAB_TITLES } from '@/modules/google-sheet-products-for-shop/lib/variation-tabs'
import { getSheetModifiedTime, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import type { PushVariationTab } from '@/modules/google-sheet-products-for-shop/lib/types'

// Only absorbs clock skew between Google's modifiedTime and the database clock; a
// real owner edit lands minutes or hours after a sync, well beyond it. Matches the
// old synchronous push. See the edit-guard note below.
const SYNC_SKEW_MS = 120_000

// Start a Push: snapshot the catalogue, then hand the browser a job id to step
// through. Products are written before the product variation tabs (those tabs
// reference product slugs), and the whole thing runs one bounded batch at a time
// because a catalogue with dozens of variable products is dozens of tab writes -
// far past what one 60s request can do. See migrations/007_push_job.sql.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Refuse to push over the top of a Pull applying the sheet to the shop: a push
  // would rewrite the very sheet being read and move the deletion baseline.
  if (await getLatestUnfinishedPullJob()) {
    return errorResponse('A pull from the sheet is in progress. Finish or cancel it before pushing.', 409)
  }

  // A push already under way (running, or failed mid-way with its cursor intact):
  // hand the browser that job to resume rather than starting a second one.
  const existing = await getLatestUnfinishedPushJob()
  if (existing) {
    return NextResponse.json({ pushJobId: existing.id, resume: true, status: pushStatus(existing) }, { status: 409 })
  }

  try {
    // Edit guard, run once at start (a stepped push can span minutes): refuse to
    // overwrite a sheet edited since Cactus last synced it, unless the owner has
    // confirmed. last_push_attempt_at covers a previous half-done push's own writes.
    const body = await req.json().catch(() => ({}))
    const force = body && typeof body === 'object' && body.force === true
    if (!force) {
      const modifiedAt = await getSheetModifiedTime(conn.spreadsheetId)
      const syncedAtMs = Math.max(
        conn.lastPushAt?.getTime() ?? 0,
        conn.lastPullAt?.getTime() ?? 0,
        conn.lastPushAttemptAt?.getTime() ?? 0,
      )
      if (modifiedAt && syncedAtMs > 0 && modifiedAt.getTime() > syncedAtMs + SYNC_SKEW_MS) {
        return NextResponse.json(
          {
            error: 'The sheet has been edited since Cactus last synced it. Pushing now overwrites those edits with the current catalogue.',
            needsConfirm: true,
            modifiedAt: modifiedAt.toISOString(),
          },
          { status: 409 },
        )
      }
    }

    // Snapshot the catalogue: the Products grid and one narrow grid per variable
    // product. Titles are assigned here so a resumed step writes to the same tabs -
    // reusing the title the last Push gave each product (kept in the manifest) so an
    // existing tab is written into, not orphaned beside a fresh one.
    // Which optional columns go in the sheet at all (stock, trade price) is the
    // owner's setting, read here so both grids are built to the same shape.
    const prefs = columnPrefsFrom(conn)
    const [productsGrid, productTabs] = await Promise.all([buildProductsGrid(prefs), buildVariationTabs(prefs)])

    const manifestBySlug = new Map((conn.variationTabManifest ?? []).map((m) => [m.slug, m.title]))
    const taken = new Set<string>()
    const withReusedTitle = productTabs.map((t) => {
      const prev = manifestBySlug.get(t.slug)
      if (prev && !taken.has(prev) && !RESERVED_TAB_TITLES.has(prev)) { taken.add(prev); return { t, title: prev as string | null } }
      return { t, title: null as string | null }
    })
    const variationTabs: PushVariationTab[] = withReusedTitle.map(({ t, title }) => ({
      slug: t.slug,
      name: t.name,
      title: title ?? productTabTitle(t.name, t.slug, taken),
      grid: t.grid,
    }))

    const { id } = await createPushJob({ force, productsGrid, variationTabs, runBy: user.id })
    return NextResponse.json({ pushJobId: id, tabsTotal: variationTabs.length, phase: 'PRODUCTS' })
  } catch (err) {
    if (err instanceof PushAlreadyRunningError) {
      const again = await getLatestUnfinishedPushJob()
      return again
        ? NextResponse.json({ pushJobId: again.id, resume: true, status: pushStatus(again) }, { status: 409 })
        : errorResponse('A push is already in progress.', 409)
    }
    const message = err instanceof GoogleAuthError ? err.message : `The push could not start. ${sheetFailureReason(err)}`
    return errorResponse(message, err instanceof GoogleAuthError ? 400 : 502)
  }
}
