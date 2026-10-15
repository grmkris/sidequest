import { parseHostedAdmission } from '@sidequest/board'
import { Schema } from 'effect'
import type { AdmissionReply } from './admission-rate.ts'
import type { DirectoryCall } from './directory-object.ts'

const SignedKind = Schema.Struct({ kind: Schema.Literals(['Enrollment', 'ServiceAd', 'Heartbeat', 'RevokeAd']) })
const OptOut = Schema.Struct({ enrolled: Schema.Literal(false) })
const SignedOptOut = Schema.Struct({ payload: OptOut })

/** Directory signatures authorize writes. The full signed payload identifies recovery opt-outs during drain. */
export function directoryPolicy(
  bindings: Record<string, unknown>,
  request: DirectoryCall,
): Exclude<AdmissionReply, { ok: true }> | undefined {
  if (bindings.NETWORK !== request.network)
    return { ok: false, code: 'forbidden', message: 'directory runtime network mismatch' }
  if (request.action === 'read') return undefined
  if (request.action !== 'prepare' && request.action !== 'submit')
    return { ok: false, code: 'invalid', message: 'unknown directory action or signed kind' }
  const source = request.action === 'prepare' ? request : request.record
  if (!Schema.is(SignedKind)(source))
    return { ok: false, code: 'invalid', message: 'unknown directory action or signed kind' }
  const optOut =
    request.action === 'prepare' ? Schema.is(OptOut)(request.payload) : Schema.is(SignedOptOut)(request.record)
  if (
    (request.network !== 'monad-mainnet' && bindings.DEPLOY_STAGE !== 'prod') ||
    source.kind === 'RevokeAd' ||
    (source.kind === 'Enrollment' && optOut)
  )
    return undefined
  if (
    !parseHostedAdmission(Schema.is(Schema.String)(bindings.PROD_ADMISSION_DRAIN) ? bindings.PROD_ADMISSION_DRAIN : '1')
      .drain
  )
    return undefined
  return { ok: false, code: 'forbidden', message: 'directory listing is paused' }
}
