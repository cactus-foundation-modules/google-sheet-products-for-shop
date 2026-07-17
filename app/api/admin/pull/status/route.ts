import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPullJob, getLatestUnfinishedPullJob } from '@/modules/google-sheet-products-for-shop/lib/pull-job'
import { pullStatus } from '@/modules/google-sheet-products-for-shop/lib/pull-run'

// The live snapshot the progress UI polls. With a pullJobId it returns that job's
// snapshot; without one it returns the most recent unfinished job (what the
// toolbar checks on load to decide whether to offer Continue), or null.
export async function GET(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const id = req.nextUrl.searchParams.get('pullJobId')
  const job = id ? await getPullJob(id) : await getLatestUnfinishedPullJob()
  if (!job) return NextResponse.json({ status: null })
  return NextResponse.json({ status: await pullStatus(job) })
}
