import { Schema } from 'effect'

const Result = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  approval: Schema.optionalKey(Schema.Struct({ status: Schema.String })),
})

/** A successful HTTP response may still mean pending or reverted; never silently equate it with publication. */
export function approvalResult(value: unknown): string {
  const unknown = 'The decision response did not confirm completion. Refresh this request to check its recorded state.'
  if (!Schema.is(Result)(value)) return unknown
  const status = value.status ?? value.approval?.status ?? ''
  switch (status) {
    case 'confirmed':
      return 'Operation confirmed.'
    case 'rejected':
      return 'Request rejected. Nothing was sent by this decision.'
    case 'pending':
      return 'Approval saved. The operation is still pending; execution is not confirmed. Check this same request before retrying.'
    case 'reverted':
      return 'The transaction reverted. This operation did not complete. Review this operation before trying again.'
    case 'dropped':
      return 'The transaction was dropped. Execution is not confirmed. Review this operation before trying again.'
    case 'approval':
      return 'This request needs a fresh approval. Review its exact budget again.'
    default:
      return unknown
  }
}
