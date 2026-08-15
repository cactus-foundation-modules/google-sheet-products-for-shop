import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { stepPreviewJob } from '@/modules/google-sheet-products-for-shop/lib/preview-run'

// Run one bounded slice of the sheet check and return the live snapshot. The
// browser loops this until the snapshot says done. Read-only throughout.
export async function POST(req: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'googlesheets.manage'))) return errorResponse('Forbidden', 403)

  const body = await req.json().catch(() => ({}))
  const previewJobId = typeof body?.previewJobId === 'string' ? body.previewJobId : null
  if (!previewJobId) return errorResponse('Missing previewJobId', 400)

  const status = await stepPreviewJob(previewJobId)
  if (!status) return errorResponse('That check is no longer there. Close this and try again.', 404)
  return NextResponse.json({ status })
}
