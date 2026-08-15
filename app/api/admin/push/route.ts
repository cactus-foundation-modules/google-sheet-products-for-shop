import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { createPushJob, getLatestUnfinishedPushJob, PushAlreadyRunningError } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { pushStatus } from '@/modules/google-sheet-products-for-shop/lib/push-run'
import { getRunningPreviewJob, expireStalePreviewJobs } from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import { getSheetModifiedTime, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// Only absorbs clock skew between Google's modifiedTime and the database clock; a
// real owner edit lands minutes or hours after a sync, well beyond it. Matches the
// old synchronous push. See the edit-guard note below.
const SYNC_SKEW_MS = 120_000

// Start a Push and hand the browser a job id to step through. Products are
// written before the product variation tabs (those tabs reference product slugs),
// and the whole thing runs one bounded batch at a time because a catalogue with
// dozens of variable products is dozens of tab writes - far past what one 60s
// request can do. See migrations/007_push_job.sql.
//
// This route no longer builds the catalogue snapshot itself. It used to, and on a
// real catalogue that is most of a minute of database work before the owner sees
// anything at all - and past sixty seconds, no answer ever came. The first two
// steps build it instead (see migrations/013), so the dialog opens at once and
// says which half it is on.
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

  // And while a check of the sheet is reading it: the check's reads and this
  // push's writes share Google's per-minute quota, and the tabs it is part-way
  // through reading are the ones this push is about to rewrite. A check left
  // RUNNING by a closed browser is retired first, so it cannot block a Push for
  // ever on behalf of nobody.
  await expireStalePreviewJobs().catch(() => {})
  if (await getRunningPreviewJob()) {
    return errorResponse('Your sheet is being checked right now. Let that finish (or close it), then push.', 409)
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

    const { id } = await createPushJob({ force, runBy: user.id })
    return NextResponse.json({ pushJobId: id, tabsTotal: 0, phase: 'BUILD_PRODUCTS' }, { status: 202 })
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
