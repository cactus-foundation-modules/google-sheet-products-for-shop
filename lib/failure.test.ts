import { describe, it, expect } from 'vitest'
import { describeFailure, OwnerMessageError } from '@/modules/google-sheet-products-for-shop/lib/failure'
import { SheetsApiError } from '@/modules/google-sheet-products-for-shop/lib/sheets'
import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'

// The live failure this exists for, verbatim from a furniture retailer's screen:
const PRISMA_CONNECTION_ERROR =
  'Invalid `prisma.$queryRaw()` invocation: Can\'t reach database server at `db.dwoffice.furniture:6432` ' +
  'Please make sure your database server is running at `db.dwoffice.furniture:6432`.'

describe('describeFailure', () => {
  it('never puts a database hostname or port in front of the owner', () => {
    const f = describeFailure(new Error(PRISMA_CONNECTION_ERROR), 'check')
    expect(f.message).not.toMatch(/dwoffice\.furniture/)
    expect(f.message).not.toMatch(/6432/)
    expect(f.message).not.toMatch(/prisma/i)
    expect(f.message).not.toMatch(/queryRaw/)
    // And it reads like something a shopkeeper can act on.
    expect(f.message).toMatch(/database/i)
    expect(f.message).toMatch(/nothing has been lost/i)
    // The specifics survive, for the log.
    expect(f.detail).toMatch(/dwoffice\.furniture/)
  })

  it('treats a lost database connection as worth trying again', () => {
    // A blip is the one thing that must NOT end a run: it had already thrown away
    // three and a half minutes of completed work when it did.
    expect(describeFailure(new Error(PRISMA_CONNECTION_ERROR), 'check').transient).toBe(true)
    expect(describeFailure(new Error('Timed out fetching a new connection from the connection pool'), 'pull').transient).toBe(true)
    expect(describeFailure(new Error('Error: connect ECONNREFUSED 10.0.0.1:6432'), 'push').transient).toBe(true)
    expect(describeFailure(new Error('FATAL: sorry, too many clients already'), 'check').transient).toBe(true)
  })

  it('passes our own wording straight through', () => {
    const f = describeFailure(new OwnerMessageError('Your sheet has no product variation tabs.'), 'check')
    expect(f.message).toBe('Your sheet has no product variation tabs.')
    expect(f.transient).toBe(false)
  })

  it('keeps Google failures in their own plain English, and knows which clear', () => {
    const rateLimited = describeFailure(new SheetsApiError('read grid', 429, 'Quota exceeded'), 'check')
    expect(rateLimited.transient).toBe(true)
    expect(rateLimited.message).toMatch(/limiting how fast/i)

    const renamedTab = describeFailure(new SheetsApiError('read grid', 400, 'Unable to parse range: Products'), 'check')
    expect(renamedTab.transient).toBe(false)
    expect(renamedTab.message).toMatch(/renamed or deleted/i)

    const refused = describeFailure(new GoogleAuthError('Reconnect the account on the settings page.'), 'check')
    expect(refused.message).toMatch(/Reconnect/)
    expect(refused.transient).toBe(false)
  })

  it('says something useful about an error written for a programmer, without quoting it', () => {
    const f = describeFailure(new TypeError("Cannot read properties of undefined (reading 'slug')"), 'pull')
    expect(f.message).not.toMatch(/undefined/)
    expect(f.message).toMatch(/something went wrong/i)
    expect(f.message).toMatch(/nothing has been lost/i)
    expect(f.detail).toMatch(/TypeError/)
  })
})
