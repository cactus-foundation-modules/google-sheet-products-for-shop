import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { cancelPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'

// Abandon an unfinished Pull. Whatever batches already landed stay (they were
// real, idempotent writes); the job simply stops offering Continue.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const pullJobId = typeof body?.pullJobId === 'string' ? body.pullJobId : null
  if (!pullJobId) return errorResponse('Missing pullJobId', 400)

  await cancelPullJob(pullJobId)
  return NextResponse.json({ ok: true })
}
