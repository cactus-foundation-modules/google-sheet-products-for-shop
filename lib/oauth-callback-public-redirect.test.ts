import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/session', () => ({ getSessionFromCookie: async () => null }))

const { GET } = await import('@/modules/google-sheet-products-for-shop/app/api/admin/oauth/google/callback/route')

let saved: Array<[string, string | undefined]> = []
beforeEach(() => {
  saved = ['CACTUS_HOSTING_PROVIDER', 'SITE_URL', 'VERCEL'].map((k) => [k, process.env[k]])
  delete process.env.VERCEL
  process.env.CACTUS_HOSTING_PROVIDER = 'server'
  process.env.SITE_URL = 'https://shop.example'
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

it('sends a signed-out visitor to the public home page, not the bind address', async () => {
  const request = new NextRequest('https://localhost:3101/api/m/google-sheet-products-for-shop/admin/oauth/google/callback', {
    headers: { host: 'shop.example', 'x-forwarded-proto': 'https' },
  })
  const res = await GET(request)
  expect(res.headers.get('location')).toBe('https://shop.example/')
})
