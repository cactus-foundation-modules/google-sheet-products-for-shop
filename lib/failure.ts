import { GoogleAuthError } from '@/modules/google-sheet-products-for-shop/lib/google-token'
import { SheetsApiError, sheetFailureReason } from '@/modules/google-sheet-products-for-shop/lib/sheets'

// What a step failure says to the owner, and whether it is worth trying again.
//
// This exists because a database hiccup put THIS on a furniture retailer's screen:
//
//   Invalid `prisma.$queryRaw()` invocation: Can't reach database server at
//   `db.dwoffice.furniture:6432` Please make sure your database server is running
//
// Three things wrong with that at once. It means nothing to the person reading
// it; it publishes an internal hostname and port to anyone they show the screen
// to; and it reads like a verdict when the truth was a busy moment that had
// already passed. The detail belongs in the log, where it is genuinely useful,
// and the owner gets a sentence about what happened and what to do.
//
// An error we RAISED OURSELVES is different: its text was written for the owner
// in the first place. Those are thrown as OwnerMessageError and pass through.

/** An error whose message was written to be read by the site's owner. */
export class OwnerMessageError extends Error {}

// Shapes a lost or refused database connection takes. Prisma wraps these in its
// own prose, so the text is matched rather than any one error code - P1001 and
// P2024 are the documented ones, but a pooler refusing a client mid-query
// surfaces in several ways and they all mean the same thing to us: the database
// was briefly out of reach, and it very probably is not any more.
const TRANSIENT_DATABASE = [
  /can't reach database server/i,
  /connection pool/i,
  /timed out fetching a new connection/i,
  /server has closed the connection/i,
  /connection closed/i,
  /too many clients/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /P1001|P1017|P2024/,
]

export type Failure = {
  /** Safe to show. Never carries a hostname, a port, or a query. */
  message: string
  /** Worth trying again on its own: the cause is expected to clear. */
  transient: boolean
  /** For the server log only. */
  detail: string
}

/**
 * `what` names the job in the owner's terms - "check", "pull", "push" - so the
 * sentence reads about the thing they pressed rather than about a subsystem.
 */
export function describeFailure(err: unknown, what: string): Failure {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

  // Our own wording, written for this audience.
  if (err instanceof OwnerMessageError) return { message: err.message, transient: false, detail }

  // Google, which already has a careful plain-English reading of its own.
  if (err instanceof GoogleAuthError) return { message: err.message, transient: false, detail }
  if (err instanceof SheetsApiError) {
    return { message: sheetFailureReason(err), transient: err.status === 429 || err.status >= 500, detail }
  }

  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  if (TRANSIENT_DATABASE.some((re) => re.test(text))) {
    return {
      message:
        `Your site briefly could not reach its database, so the ${what} stopped where it was. ` +
        'This is usually a busy moment rather than a fault, and nothing has been lost - it carries on from here.',
      transient: true,
      detail,
    }
  }

  // Anything else is a fault worth reporting, but its text was written for
  // whoever wrote the code. Say so plainly and keep the specifics in the log.
  return {
    message:
      `Something went wrong on your site during the ${what}, so it stopped where it was. ` +
      'Nothing has been lost. Try again, and if it keeps happening the details are in your site logs.',
    transient: false,
    detail,
  }
}

/**
 * The reason recorded against ONE ROW of a sync.
 *
 * Row errors are usually domain problems our own importers phrase well - "SKU
 * already in use", "Parent product not found" - so the message is kept. The
 * exception is an infrastructure failure that happened to strike mid-row: that
 * one gets the plain sentence, because it is the case that carries a hostname.
 */
export function rowFailureReason(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  const text = `${err.name}: ${err.message}`
  if (TRANSIENT_DATABASE.some((re) => re.test(text))) {
    return 'Your site briefly could not reach its database while this row was being written. Nothing was changed for it - try again.'
  }
  return err.message || fallback
}
