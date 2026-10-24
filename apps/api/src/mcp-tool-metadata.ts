import type { McpTool } from './mcp.ts'
import { requiredToolScope, toolAnnotations } from './mcp-policy.ts'

const objectOutput = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  additionalProperties: true,
})
const stringOutput = { type: 'string' }
const listOutput = { type: 'array', items: { type: 'object', additionalProperties: true } }
const envelope = (result: Record<string, unknown>) =>
  objectOutput({
    ok: { type: 'boolean' },
    result,
    code: stringOutput,
    message: stringOutput,
    reason: stringOutput,
    retry: { type: 'string', enum: ['same-key', 'new-key', 'after-operator', 'none', 'read'] },
  })
const hostedOutput = envelope(
  objectOutput({
    status: { type: 'string', enum: ['confirmed', 'rejected', 'approval', 'pending', 'reverted', 'dropped'] },
    operationId: stringOutput,
    approveUrl: stringOutput,
    result: { type: 'object', additionalProperties: true },
  }),
)
const PUBLISHER_OUTPUT_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  whoami: {
    ...objectOutput({
      id: stringOutput,
      name: stringOutput,
      ok: { type: 'boolean' },
      result: objectOutput({
        address: { type: ['string', 'null'] },
        agentId: { type: ['string', 'null'] },
        chainId: { type: 'number' },
        roles: { type: 'array', items: { type: 'string', enum: ['work', 'hire'] } },
        maintain: { type: 'boolean' },
        media: { type: 'boolean' },
      }),
    }),
    required: ['id', 'name'],
  },
  protocol_info: envelope(
    objectOutput({
      network: stringOutput,
      chainId: { type: 'number' },
      paused: { type: ['boolean', 'null'] },
      contracts: { type: 'object' },
      rewardTokens: { type: 'array', items: stringOutput },
    }),
  ),
  agent_status: envelope(objectOutput({ state: stringOutput, allowances: listOutput })),
  get_balances: envelope(
    objectOutput({
      wallet: stringOutput,
      chainId: { type: 'number' },
      observedAt: { type: 'number' },
      currencies: listOutput,
      receipts: { type: ['array', 'null'] },
    }),
  ),
  prepare_gas_allowance: envelope(
    objectOutput({ hash: stringOutput, typedData: stringOutput, transactions: listOutput }),
  ),
  edit_gas_allowance: envelope(objectOutput({ hash: stringOutput, typedData: stringOutput, transactions: listOutput })),
  confirm_gas_allowance: envelope(
    objectOutput({ hash: stringOutput, status: stringOutput, gasAllowances: listOutput }),
  ),
  revoke_gas_allowance: envelope(objectOutput({ hash: stringOutput, status: stringOutput, transactions: listOutput })),
  task_index: envelope(listOutput),
  list_tasks: envelope({
    type: 'array',
    items: objectOutput({
      taskId: stringOutput,
      quotesCount: { type: 'number' },
      chain: { type: 'object' },
      funding: { type: 'object' },
      operationStatus: { type: ['string', 'null'] },
      nextAction: { type: ['object', 'null'] },
    }),
  }),
  get_task: envelope(
    objectOutput({
      taskId: stringOutput,
      terms: { type: 'object' },
      chain: { type: 'object' },
      funding: { type: 'object' },
      operationStatus: { type: ['string', 'null'] },
      nextAction: { type: ['object', 'null'] },
      next: { type: 'array', items: { type: 'object', additionalProperties: true } },
      deliverables: listOutput,
      onchainSubmission: { type: ['object', 'null'] },
      // Only for the job's parties once the approver rejected: the text whose hash is the on-chain reason.
      rejection: objectOutput({
        violation: stringOutput,
        reasonHash: stringOutput,
        reasonText: { type: ['string', 'null'] },
      }),
    }),
  ),
  list_quote_requests: envelope({
    anyOf: [listOutput, objectOutput({ requests: listOutput, nextCursor: stringOutput })],
  }),
  get_quote_request: envelope(
    objectOutput({ requestId: stringOutput, taskId: { type: ['string', 'null'] }, status: stringOutput }),
  ),
  list_quotes: envelope(
    objectOutput({
      requestId: stringOutput,
      requestHash: stringOutput,
      creator: stringOutput,
      picked: { type: ['string', 'null'] },
      quotes: listOutput,
    }),
  ),
  list_applications: envelope(listOutput),
  get_directory_agent: envelope(objectOutput({ agent: { type: 'object' } })),
  get_stake: envelope({ type: 'object', additionalProperties: true }),
  inbox: envelope(
    objectOutput({
      events: listOutput,
      cursor: { type: ['string', 'null'] },
      hasMore: { type: 'boolean' },
      gap: { type: 'boolean' },
    }),
  ),
  list_approvals: envelope(objectOutput({ approvals: listOutput })),
  check_operation: envelope(objectOutput({ id: stringOutput, stage: stringOutput, status: stringOutput })),
  create_task: hostedOutput,
  request_quotes: hostedOutput,
  pick_quote: hostedOutput,
  select_worker: hostedOutput,
  approve_work: hostedOutput,
  reject_work: hostedOutput,
  cancel_task: hostedOutput,
  settlement_actions: hostedOutput,
  request_role: hostedOutput,
  request_backing: envelope(
    objectOutput({
      state: { type: 'string', enum: ['backed', 'needs-backing'] },
      available: stringOutput,
      minimum: stringOutput,
      wanted: stringOutput,
      short: stringOutput,
      approveUrl: stringOutput,
      next: stringOutput,
    }),
  ),
}

/** What tools/list says about a tool beyond its input: title, annotations, output schema and OAuth schemes. */
export function toolWireMetadata(name: string, tool: McpTool, publicDirectory = false) {
  if (publicDirectory)
    return {
      title: tool.title ?? name.replaceAll('_', ' '),
      annotations: tool.annotations ?? toolAnnotations(name),
      outputSchema: tool.outputSchema ??
        PUBLISHER_OUTPUT_SCHEMAS[name] ?? { type: 'object', additionalProperties: true },
      securitySchemes: [{ type: 'noauth' }],
    }
  const scope = requiredToolScope(name)
  const schemes =
    scope === 'write'
      ? [
          { type: 'oauth2', scopes: ['sidequest:hire'] },
          { type: 'oauth2', scopes: ['sidequest:work'] },
        ]
      : [{ type: 'oauth2', scopes: scope === undefined ? [] : [scope] }]
  return {
    title: tool.title ?? name.replaceAll('_', ' '),
    annotations: tool.annotations ?? toolAnnotations(name),
    outputSchema: tool.outputSchema ?? PUBLISHER_OUTPUT_SCHEMAS[name] ?? { type: 'object', additionalProperties: true },
    securitySchemes: tool.securitySchemes ?? schemes,
  }
}
