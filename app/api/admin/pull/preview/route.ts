import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getLatestUnfinishedPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import {
  createPreviewJob, getRunningPreviewJob, pruneOldPreviewJobs, expireStalePreviewJobs, PreviewAlreadyRunningError,
} from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import { previewStatus } from '@/modules/google-sheet-products-for-shop/lib/preview-run'

// Start a check of the sheet: what would a Pull actually do? Nothing is written
// to the catalogue at any point.
//
// This used to BE the check - one request that read the whole workbook and
// compared it with the whole catalogue before it answered, which on a real
// catalogue is minutes of work inside a route the platform kills at sixty
// seconds. It now just creates the job (see migrations/012) and hands back an id;
// the browser drives it a bounded step at a time and watches the progress.
export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Refuse while a Push is part-way through, before touching Google at all. A
  // running push is spending the same sixty-reads-a-minute quota this check
  // needs, and it is rewriting the very tabs the check would read - a torn
  // snapshot even when the reads do squeak in. Push has the mirror guard.
  if (await getLatestUnfinishedPushJob()) {
    return errorResponse('A push to the sheet is part-way through. Open Push and let it finish (or cancel it), then pull.', 409)
  }
  // And a Pull already applying the sheet: checking it now would report against a
  // catalogue that is changing under the check as it runs.
  if (await getLatestUnfinishedPullJob()) {
    return errorResponse('A pull is already in progress. Continue or cancel it first.', 409)
  }

  // Retire anything left RUNNING by a browser that was closed mid-check, so the
  // one-at-a-time index does not refuse this one on behalf of a ghost.
  await expireStalePreviewJobs().catch(() => {})

  // Two admin tabs, or a double-click, join the check already in flight rather
  // than starting a second one against the same quota.
  const running = await getRunningPreviewJob()
  if (running) return NextResponse.json({ previewJobId: running.id, status: previewStatus(running), joined: true })

  await pruneOldPreviewJobs().catch(() => {})
  try {
    const { id } = await createPreviewJob({ runBy: user.id })
    return NextResponse.json({ previewJobId: id }, { status: 202 })
  } catch (err) {
    if (err instanceof PreviewAlreadyRunningError) {
      const again = await getRunningPreviewJob()
      if (again) return NextResponse.json({ previewJobId: again.id, status: previewStatus(again), joined: true })
      return errorResponse('A check of your sheet is already running.', 409)
    }
    throw err
  }
}
