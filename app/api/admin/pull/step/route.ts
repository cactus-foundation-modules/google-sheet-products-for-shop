import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { stepPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-run'

// Run one bounded batch of a Pull and return the live snapshot. The browser loops
// this until the snapshot says done; a Continue button just re-enters the loop.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const pullJobId = typeof body?.pullJobId === 'string' ? body.pullJobId : null
  if (!pullJobId) return errorResponse('Missing pullJobId', 400)

  const status = await stepPullJob(pullJobId, user.email)
  if (!status) return errorResponse('Pull job not found.', 404)
  return NextResponse.json({ status })
}
