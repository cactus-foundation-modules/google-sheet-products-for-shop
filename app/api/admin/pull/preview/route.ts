import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getLatestUnfinishedPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import {
  createPreviewJob, getPreviewJob, getRunningPreviewJob, getResumablePreviewJob, resumePreviewJob,
  pruneOldPreviewJobs, expireStalePreviewJobs, cancelPreviewJob, PreviewAlreadyRunningError,
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
export async function POST(req: NextRequest) {
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

  // "Start again from the first tab", which the owner has to ask for explicitly.
  const body = await req.json().catch(() => ({}))
  const wantsFresh = body && typeof body === 'object' && body.fresh === true

  // CARRY ON before anything else. A check already running is joined; one that
  // stopped part-way keeps its place and is put back to work. Only when there is
  // genuinely nothing to carry on with does a new one get made.
  //
  // The order here is the whole fix. Retiring stale jobs used to come FIRST, and
  // it cancelled and gutted them - so a check three quarters of the way through a
  // big catalogue was destroyed by the very button offered to continue it, and
  // started again at the first tab. Nothing is thrown away now unless the owner
  // says so.
  if (!wantsFresh) {
    const resumable = await getResumablePreviewJob()
    if (resumable) {
      const wasStopped = resumable.status === 'FAILED'
      if (wasStopped) await resumePreviewJob(resumable.id)
      // Re-read the one we just touched, by id. The resume can decline (another
      // check holds the one-at-a-time slot), and the honest thing to report is
      // what the row actually says now rather than what we asked it to become.
      const refreshed = (await getPreviewJob(resumable.id)) ?? resumable
      return NextResponse.json({
        previewJobId: refreshed.id,
        status: previewStatus(refreshed),
        resumed: wasStopped && refreshed.status === 'RUNNING',
        joined: !wasStopped,
      })
    }
  }

  // Starting fresh on purpose: stand down whatever was there, so the
  // one-at-a-time index does not refuse the new one.
  const existing = await getResumablePreviewJob()
  if (existing) await cancelPreviewJob(existing.id).catch(() => {})
  await expireStalePreviewJobs().catch(() => {})
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
