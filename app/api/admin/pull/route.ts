import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { createImportJob, markImportJobStarted, markImportJobCompleted } from '@/modules/shop/lib/db/import-jobs'
import { getConnection } from '@/modules/google-sheet-products-for-shop/lib/db'
import { getSheetModifiedTime } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { createPullJob, getLatestUnfinishedPullJob, PullAlreadyRunningError } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { getLatestUnfinishedPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { getPreviewJobLight } from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import type { PullDetected, PreviewJobLight, StoredDeletionPlan } from '@/modules/google-sheet-products-for-shop/lib/types'

// How old a finished check may be and still be adopted. A Pull is normally
// pressed seconds after the dialog lists what it will do; a dialog left open over
// lunch is re-checked rather than trusted, because the catalogue may have moved
// underneath it in the meantime.
// How long a FINISHED check may sit before a Pull stops trusting it. Measured
// from when it finished, not when it started - see below, because getting that
// wrong is what made the owner sit through the whole comparison twice.
const PREVIEW_MAX_AGE_MS = 30 * 60_000

// The same, for the awkward case where Drive will not say when the sheet was
// last touched - it answers null rather than failing, and has been known to. With
// no timestamp on either side there is nothing to compare, so the only honest
// guard left is how recently the owner looked at the list. Kept short: minutes of
// exposure to an edit made in another tab, against a Pull that could otherwise
// never be started at all on a site where Drive is quiet.
const PREVIEW_NO_DRIVE_MAX_AGE_MS = 2 * 60_000

// Start a Pull.
//
// This route does no reading and no comparing. The check the owner just
// confirmed (see lib/preview-run.ts) read every tab, compared every row and
// planned every deletion, and it kept all of it - so all that is left here is to
// adopt those results and create the job the browser will step through.
//
// It used to do the whole sweep itself, a second time, inside one request: read
// the workbook, build the catalogue's CSV view, diff every row, plan every
// deletion. That is minutes of work on a real catalogue and the platform kills a
// module route at sixty seconds, so on a big shop the Pull could not start at
// all - and when it could, it had just spent that time proving again what the
// dialog had already shown. Refusing a stale check (below) and asking the browser
// to run another one is both quicker and honest: a check reports its progress and
// cannot run out of time, and this route can no longer be the thing that hangs.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const conn = await getConnection()
  if (!conn?.spreadsheetId) return errorResponse('Create the Google Sheet first.', 400)

  // Only one Pull at a time. If an earlier one is paused or failed mid-run, the
  // owner must Continue or cancel it rather than start a second that races it.
  // This is the fast, friendly check; the real race guard is the partial unique
  // index (migrations/006), caught below when two starts slip past this together.
  const existing = await getLatestUnfinishedPullJob()
  if (existing) {
    return NextResponse.json(
      { error: 'A pull is already in progress. Continue or cancel it first.', pullJobId: existing.id },
      { status: 409 },
    )
  }

  // Refuse while a Push is part-way through: it is rewriting the very tabs the
  // check read. Push has the mirror guard against a running Pull.
  if (await getLatestUnfinishedPushJob()) {
    return errorResponse('A push to the sheet is part-way through. Open Push and let it finish (or cancel it), then pull.', 409)
  }

  const body = await req.json().catch(() => ({}))
  const previewJobId = body && typeof body === 'object' && typeof body.previewJobId === 'string' ? body.previewJobId : null

  const adopted = previewJobId ? await adoptPreview(previewJobId, conn.spreadsheetId) : null
  if (!adopted) {
    // No usable check. The browser re-runs one (which is bounded, reports its
    // progress, and shows the owner the new answer to confirm) rather than this
    // route quietly doing the work with nothing on screen.
    return NextResponse.json(
      {
        error: 'Your sheet has changed since it was checked, so this list is out of date. Checking it again now.',
        stalePreview: true,
      },
      { status: 409 },
    )
  }

  const started = await startPullJob({ ...adopted, runBy: user.id })
  if ('error' in started) return started.error
  return NextResponse.json(started.body, { status: 202 })
}

// What a Pull needs to run.
type PullStartInput = {
  productsGrid: string[][]
  variationsGrid: string[][]
  productsRowMap: number[]
  variationsRowMap: number[]
  deletionPlan: StoredDeletionPlan
  lastPushAt: Date | null
  detected: PullDetected
  runBy: string
}

// Create shop's import job and this module's pull job, in that order, and give
// back what the browser needs to start stepping.
async function startPullJob(
  input: PullStartInput,
): Promise<{ body: { pullJobId: string; productsTotal: number; variationsTotal: number; detected: PullDetected } } | { error: NextResponse }> {
  const productsTotal = Math.max(input.productsGrid.length - 1, 0)
  const variationsTotal = Math.max(input.variationsGrid.length - 1, 0)

  // The shop import job carries the products phase and its live per-row progress.
  const { id: shopImportJobId } = await createImportJob({ filename: 'Google Sheet pull', totalRows: productsTotal, createdBy: input.runBy, columnMap: null })
  await markImportJobStarted(shopImportJobId)

  // If creating the pull job fails - a lost connection, or the concurrency guard
  // firing on a race - the shop import job we just started must not be left
  // "running" forever in shop's own listing. Fail it, then surface the reason.
  try {
    const { id: pullJobId } = await createPullJob({
      productsGrid: input.productsGrid,
      variationsGrid: input.variationsGrid,
      productsRowMap: input.productsRowMap,
      variationsRowMap: input.variationsRowMap,
      deletionPlan: input.deletionPlan,
      lastPushAt: input.lastPushAt,
      shopImportJobId,
      detected: input.detected,
      productsTotal, variationsTotal,
      runBy: input.runBy,
    })
    return { body: { pullJobId, productsTotal, variationsTotal, detected: input.detected } }
  } catch (err) {
    await markImportJobCompleted(shopImportJobId, 'FAILED').catch(() => {})
    if (err instanceof PullAlreadyRunningError) {
      const running = await getLatestUnfinishedPullJob()
      return {
        error: NextResponse.json(
          { error: 'A pull is already in progress. Continue or cancel it first.', pullJobId: running?.id },
          { status: 409 },
        ),
      }
    }
    throw err
  }
}

// May this finished check be acted on? Only when it finished cleanly, has
// everything a Pull needs, is minutes rather than hours old, and the sheet has
// not moved a byte since it was read - judged by an EXACT match on Drive's
// modifiedTime, the same test the snapshot reuse uses. Anything uncertain (Drive
// not answering, no stored time) reads as "no", and the owner gets a fresh check.
async function adoptPreview(previewJobId: string, spreadsheetId: string): Promise<Omit<PullStartInput, 'runBy'> | null> {
  let job: PreviewJobLight | null = null
  try {
    job = await getPreviewJobLight(previewJobId)
  } catch {
    return null
  }
  if (!job || job.status !== 'COMPLETED') return null
  if (!job.filteredProducts || !job.filteredVariations || !job.detected) return null
  if ((job.preview?.headerMissing.length ?? 0) > 0) return null

  // Age from when the check FINISHED. It used to be measured from when the check
  // STARTED, and that single word is why every Pull re-ran the whole comparison:
  // a check of this catalogue takes about a quarter of an hour, the window was a
  // quarter of an hour, so by the time the owner had a summary in front of them
  // to press Pull on, their brand-new answer was already "too old to trust" and
  // the work was thrown away and done again. The time a check spends working is
  // not time its answer has spent going stale.
  const age = Date.now() - job.updatedAt.getTime()
  const modifiedAt = await getSheetModifiedTime(spreadsheetId).catch(() => null)

  if (job.driveModifiedTime) {
    if (age > PREVIEW_MAX_AGE_MS) return null
    // Drive answered when the check ran, so it has to answer now and agree.
    if (!modifiedAt || modifiedAt.getTime() !== job.driveModifiedTime.getTime()) return null
  } else {
    // Drive would not say when the check read the sheet. If it will not say now
    // either, it is quiet for this site rather than hiding an edit, and the only
    // guard left is how fresh the list is. If it HAS found its voice since, we
    // have a timestamp we cannot compare against anything - refuse and re-check,
    // which will pin the new one down properly.
    if (modifiedAt !== null) return null
    if (age > PREVIEW_NO_DRIVE_MAX_AGE_MS) return null
  }

  return {
    productsGrid: job.filteredProducts,
    variationsGrid: job.filteredVariations,
    productsRowMap: job.productsRowMap ?? [],
    variationsRowMap: job.variationsRowMap ?? [],
    deletionPlan: job.deletionPlan ?? { products: [], variations: [] },
    lastPushAt: job.lastPushAt,
    detected: job.detected,
  }
}
