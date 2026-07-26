import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { stepPushJob } from '@/modules/google-sheet-products-for-shop/lib/push-run'

// Run one bounded batch of a Push (a few product tabs, or the products/cleanup
// phase) and return the live snapshot. The browser loops this until done; a
// Continue button just re-enters the loop.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const pushJobId = typeof body?.pushJobId === 'string' ? body.pushJobId : null
  if (!pushJobId) return errorResponse('Missing pushJobId', 400)

  const status = await stepPushJob(pushJobId)
  if (!status) return errorResponse('Push job not found.', 404)
  return NextResponse.json({ status })
}
