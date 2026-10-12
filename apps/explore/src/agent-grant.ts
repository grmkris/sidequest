/** Rebuild the expected permission locally; the server's display text is never signing authority. */
import * as sdk from '@sidequest/sdk'
import type { Address, Hex } from 'viem'
import { deployment } from './wallet.ts'

export interface PreparedGrant {
  hash: Hex
  grant: unknown
  description: { validAfter: number }
}

export type ReviewSpec =
  | { kind: 'registration' | 'operator'; delegator: Address }
  | {
      kind: 'allowance' | 'allowance-once'
      delegator: Address
      agent: Address
      token: Address
      amount: bigint
    }

export function reviewAgentGrant(prepared: PreparedGrant, expected: ReviewSpec) {
  const context = { deployment, stack: deployment.stacks.main }
  const grant = sdk.parseDelegation(JSON.stringify(prepared.grant))
  const spec = {
    ...expected,
    start: prepared.description.validAfter,
    salt: grant.salt,
  } satisfies sdk.GrantSpec
  sdk.assertGrant(context, spec, grant)
  if (sdk.delegationHash(grant) !== prepared.hash) throw new Error('The permission hash does not match the review')
  if (spec.start > Math.floor(Date.now() / 1000) + 60) throw new Error('The permission starts too far in the future')
  if (sdk.grantExpiry(spec) <= Math.floor(Date.now() / 1000))
    throw new Error('This permission expired; prepare a new review')
  return {
    hash: prepared.hash,
    typedData: sdk.delegationTypedData(deployment, grant),
    description: sdk.describeGrant(context, spec, grant),
  }
}
