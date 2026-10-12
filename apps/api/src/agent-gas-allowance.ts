/** Shared REST/MCP input boundary; the operator signs the returned Delegation typed data. */
import { AgentLifecycle, BoardError } from '@sidequest/board'
import { Schema } from 'effect'
import { type Address, type Hex, isHex } from 'viem'

const Prepare = Schema.Struct({
  key: Schema.String,
  amount: Schema.optionalKey(Schema.String),
  periodSeconds: Schema.optionalKey(Schema.Number),
})
const Confirm = Schema.Struct({ key: Schema.String, hash: Schema.String, signature: Schema.String })
const Revoke = Schema.Struct({ hash: Schema.String })
function hex(text: string, bytes: number): Hex {
  if (!isHex(text, { strict: true }) || text.length !== bytes * 2 + 2)
    throw new BoardError('invalid', 'Invalid gas allowance signature or hash')
  return text
}

export function agentGasAllowance(input: {
  readonly lifecycle: AgentLifecycle
  readonly id: string
  readonly operator: Address
  readonly action: string
  readonly body: Record<string, unknown>
}) {
  const { lifecycle, id, operator, action, body } = input
  if (action === 'gas-allowance-revoke') {
    const parsed = Schema.decodeUnknownSync(Revoke)(body)
    return lifecycle.revokeGasAllowance(id, operator, hex(parsed.hash, 32))
  }
  if (action === 'gas-allowance-confirm') {
    const parsed = Schema.decodeUnknownSync(Confirm)(body)
    return lifecycle.confirmGasAllowance(id, operator, parsed.key, hex(parsed.hash, 32), hex(parsed.signature, 65))
  }
  const parsed = Schema.decodeUnknownSync(Prepare)(body)
  if (parsed.amount !== undefined && !/^[1-9][0-9]{0,77}$/.test(parsed.amount))
    throw new BoardError('invalid', 'Invalid USDC gas amount')
  const request = {
    key: parsed.key,
    ...(parsed.amount === undefined ? {} : { amount: BigInt(parsed.amount) }),
    ...(parsed.periodSeconds === undefined ? {} : { periodSeconds: parsed.periodSeconds }),
  }
  return action === 'gas-allowance-edit'
    ? lifecycle.editGasAllowance(id, operator, request)
    : lifecycle.prepareGasAllowance(id, operator, request)
}
