import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getPreviewJobLight, getRunningPreviewJob } from '@/modules/google-sheet-products-for-shop/lib/preview-job'
import { previewStatus } from '@/modules/google-sheet-products-for-shop/lib/preview-run'

// The live snapshot the check dialog polls. With a previewJobId it returns that
// job's; without one, whichever check is still running (so a reopened dialog
// rejoins it rather than starting a second).
export async function GET(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const id = req.nextUrl.searchParams.get('previewJobId')
  const job = id ? await getPreviewJobLight(id) : await getRunningPreviewJob()
  if (!job) return NextResponse.json({ status: null })
  return NextResponse.json({ status: previewStatus(job) })
}
