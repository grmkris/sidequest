/** Operator display context from the frozen preparation. No chain reads, signing material or mutable task lookup. */
import type { AgentStore, ApprovalRow } from '@sidequest/board'
import { sidequestHoldingAbi } from '@sidequest/sdk'
import { Schema } from 'effect'
import { decodeFunctionData, keccak256, stringToHex } from 'viem'

const Preparation = Schema.Struct({ taskId: Schema.String, manifest: Schema.String })
const Hire = Schema.Struct({
  taskId: Schema.String,
  title: Schema.String,
  brief: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
})
const Request = Schema.Struct({ publish: Schema.String, token: Schema.String, amount: Schema.String })

function hireDetails(prepared: string | null, request: string) {
  if (prepared === null) return null
  try {
    const preparation = Schema.decodeUnknownSync(Preparation)(JSON.parse(prepared))
    const hire = Schema.decodeUnknownSync(Hire)(JSON.parse(preparation.manifest))
    const frozen = Schema.decodeUnknownSync(Request)(JSON.parse(request))
    if (!/^0x[0-9a-fA-F]+$/.test(frozen.publish)) return null
    // SAFETY: the hexadecimal encoding was checked above; the ABI decoder validates the call.
    const call = decodeFunctionData({ abi: sidequestHoldingAbi, data: frozen.publish as `0x${string}` })
    if (call.functionName !== 'publish') return null
    const params = call.args[0]
    const termsHash = keccak256(stringToHex(preparation.manifest))
    if (
      hire.taskId !== preparation.taskId ||
      termsHash !== params.manifestHash.toLowerCase() ||
      termsHash !== params.policyHash.toLowerCase() ||
      frozen.token.toLowerCase() !== params.token.toLowerCase() ||
      BigInt(frozen.amount) !== params.reward
    )
      return null
    return { ...hire, termsHash, creatorBond: params.creatorBond.toString() }
  } catch {
    // One unreadable preparation must not hide other approvals or invite signing without the exact brief.
    return null
  }
}

export function approvalDetails(agents: AgentStore, approval: ApprovalRow) {
  const operation = agents.operation(approval.operation_id)
  return {
    ...approval,
    context: {
      operationKey: operation.action_key,
      boardId: operation.board_id,
      tool: operation.tool,
      hire: approval.kind === 'hire-over-limit' ? hireDetails(operation.prepared_json, approval.request_json) : null,
    },
  }
}
