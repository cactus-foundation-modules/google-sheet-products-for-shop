import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { cancelPullJob, getPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { pullStatus } from '@/modules/google-sheet-products-for-shop/lib/pull-run'

// Abandon a Pull, whether it is paused, failed, or running right now. Whatever
// batches already landed stay (they were real, idempotent writes); the job stops
// offering Continue, and a step still in flight bows out at its next chunk
// boundary because every write it has left refuses to touch a cancelled job.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const pullJobId = typeof body?.pullJobId === 'string' ? body.pullJobId : null
  if (!pullJobId) return errorResponse('Missing pullJobId', 400)

  await cancelPullJob(pullJobId)
  // Hand back the snapshot as it stands, so the dialog can show what did land
  // rather than blanking the numbers the moment Stop is pressed.
  const job = await getPullJob(pullJobId)
  return NextResponse.json({ ok: true, status: job ? await pullStatus(job) : null })
}
