import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { cancelPushJob, getPushJobLight } from '@/modules/google-sheet-products-for-shop/lib/push-job'
import { pushStatus } from '@/modules/google-sheet-products-for-shop/lib/push-run'

// Abandon a Push, whether paused, failed, or running. Tabs already written stay as
// they are (they were real, idempotent writes); the job stops offering Continue,
// and a step still in flight bows out at its next tab boundary because every write
// it has left refuses to touch a cancelled job.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const pushJobId = typeof body?.pushJobId === 'string' ? body.pushJobId : null
  if (!pushJobId) return errorResponse('Missing pushJobId', 400)

  await cancelPushJob(pushJobId)
  const job = await getPushJobLight(pushJobId)
  return NextResponse.json({ ok: true, status: job ? pushStatus(job) : null })
}
