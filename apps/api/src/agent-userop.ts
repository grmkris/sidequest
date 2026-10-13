/** Mainnet always uses the hosted desk; testnet selects it through the cutover flag. */
import { AgentSigning, UserOpDesk, UserOpStore, type Sql } from '@sidequest/board'
import { hostedSendMode, type Ctx } from '@sidequest/sdk'
import * as Schema from 'effect/Schema'
import { aaRpc } from './aa-proxy.ts'

const RpcBindings = Schema.Struct({
  NETWORK: Schema.optionalKey(Schema.String),
  MONAD_RPC_URL: Schema.optionalKey(Schema.String),
  PIMLICO_API_KEY: Schema.optionalKey(Schema.String),
  TESTNET_PAYMASTER_SIGNER_KEY: Schema.optionalKey(Schema.String),
})
export function hostedUserOpDesk(input: {
  readonly bindings: Record<string, unknown>
  readonly sql: Sql
  readonly context: Ctx
  readonly signing: AgentSigning
  readonly now: () => number
}): UserOpDesk | undefined {
  const mode = Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.String))(input.bindings.HOSTED_SEND)
  if (hostedSendMode(input.context.deployment.network, mode) !== 'userop') return undefined
  const bindings = Schema.decodeUnknownSync(RpcBindings)(input.bindings)
  return new UserOpDesk({
    context: input.context,
    signing: input.signing,
    now: input.now,
    store: new UserOpStore(input.sql, input.now),
    rpc: aaRpc(bindings),
  })
}
