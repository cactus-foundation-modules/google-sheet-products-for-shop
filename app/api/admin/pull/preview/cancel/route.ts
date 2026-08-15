import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { cancelPreviewJob, getPreviewJob } from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import { previewStatus } from '@/modules/google-sheet-products-for-shop/lib/preview-run'

// Abandon a check. Nothing to undo - a check writes nothing to the catalogue -
// so this just stops the browser being asked for more steps and frees the next
// one to start. A step still in flight bows out at its next chunk boundary,
// because every write it has left refuses to touch a cancelled job.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const previewJobId = typeof body?.previewJobId === 'string' ? body.previewJobId : null
  if (!previewJobId) return errorResponse('Missing previewJobId', 400)

  await cancelPreviewJob(previewJobId)
  const job = await getPreviewJob(previewJobId)
  return NextResponse.json({ ok: true, status: job ? previewStatus(job) : null })
}
