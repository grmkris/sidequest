/**
 * MCP 2026-07-28 multi round-trip requests for operator approvals (ADR-0021). A call that waits on the operator answers
 * `input_required` with a URL elicitation; the client shows the link, then retries the same call with `requestState`.
 * The state is the approval's operation id or the new agent's key, checked against the caller on every retry, so
 * tampering can only make the retry fail.
 */
import { agentOperationId } from '@sidequest/board'
import { Schema } from 'effect'
import type { OAuthGrant } from './oauth.ts'

const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
/** The single `inputRequests` key; clients dispatch on the request's method and mode, not on this name. */
const APPROVAL_INPUT = 'approval'

const UrlCapable = Schema.Struct({
  _meta: Schema.Struct({
    [CAPABILITIES]: Schema.Struct({
      elicitation: Schema.Struct({ url: Schema.Record(Schema.String, Schema.Unknown) }),
    }),
  }),
})
const Retry = Schema.Struct({
  requestState: Schema.String,
  inputResponses: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ action: Schema.Literals(['accept', 'decline', 'cancel']) })),
  ),
})
const Approval = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    status: Schema.Literal('approval'),
    approveUrl: Schema.String,
    approval: Schema.Struct({ id: Schema.String, kind: Schema.String }),
  }),
})
const Created = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    agentKey: Schema.String,
    approveUrl: Schema.String,
    profile: Schema.Struct({ name: Schema.String }),
  }),
})

const WAITS_FOR: Readonly<Record<string, string>> = {
  'hire-over-limit': 'a hire above its weekly allowance',
  unstake: 'an exit from its stake',
  permission: 'a new permission',
  role: 'a new role',
}

export interface ApprovalPrompt {
  readonly url: string
  readonly message: string
  readonly state: string
}

/** Whether this request's client can open a URL for its user: 2026 client capabilities arrive on every request. */
export function urlElicitation(params: Record<string, unknown>): boolean {
  return Schema.is(UrlCapable)(params)
}

/** A retry's state and the user's answer to the prompt, or undefined for a first call. */
export function mrtrRetry(params: Record<string, unknown>) {
  if (!Schema.is(Retry)(params)) return undefined
  return { state: params.requestState, action: params.inputResponses?.[APPROVAL_INPUT]?.action }
}

/** The operator step a tool's answer waits on, if any: a pending approval, or a new agent to approve. */
export function approvalPrompt(tool: string, output: unknown): ApprovalPrompt | undefined {
  if (tool === 'create_agent' && Schema.is(Created)(output))
    return {
      url: output.result.approveUrl,
      message: `Approve ${output.result.profile.name} on Sidequest: choose what it may do, then register and connect it.`,
      state: output.result.agentKey,
    }
  if (!Schema.is(Approval)(output)) return undefined
  const words = WAITS_FOR[output.result.approval.kind] ?? 'an action'
  return {
    url: output.result.approveUrl,
    message: `Your agent waits for your approval of ${words} on Sidequest.`,
    state: output.result.approval.id,
  }
}

export function inputRequired(prompt: ApprovalPrompt) {
  return {
    resultType: 'input_required',
    inputRequests: {
      [APPROVAL_INPUT]: {
        method: 'elicitation/create',
        params: { mode: 'url', message: prompt.message, url: prompt.url },
      },
    },
    requestState: prompt.state,
  }
}

const SetupStatus = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Struct({ state: Schema.String }) })

/** The round passes the tool's own output through untouched, so it is typed by whatever the caller's tools return. */
/** The round passes the tool's own output through untouched, so it is typed by whatever the caller's tools return. */
export type ApprovalRound<Output> =
  | { readonly kind: 'input'; readonly result: ReturnType<typeof inputRequired> }
  | { readonly kind: 'output'; readonly output: Output }
  | { readonly kind: 'closed'; readonly url: string }
  | { readonly kind: 'invalid' }

/**
 * One tools/call on the 2026 lane. A first call that waits on the operator asks for the URL when the client can open
 * one; a retry must carry the state this connection's call was given, re-runs the same call (its operationKey makes
 * that idempotent) and asks again only while the operator has not decided. A prompt the user closed ends the call
 * without touching the approval, which still waits for the operator.
 */
export async function approvalRound<Output>(input: {
  readonly params: Record<string, unknown>
  readonly tool: string
  readonly agentId: string
  readonly args: Record<string, unknown>
  readonly run: () => Promise<Output>
  /** For create_agent: whether the operator has approved the new agent yet (its setup_status answer). */
  readonly setupStatus: (agentKey: string) => Promise<Output>
}): Promise<ApprovalRound<Output>> {
  const retry = mrtrRetry(input.params)
  const key = Schema.is(Schema.String)(input.args.operationKey) ? input.args.operationKey : ''
  if (retry !== undefined && input.tool !== 'create_agent' && retry.state !== agentOperationId(input.agentId, key))
    return { kind: 'invalid' }
  const output = await input.run()
  const prompt = retry !== undefined || urlElicitation(input.params) ? approvalPrompt(input.tool, output) : undefined
  if (prompt === undefined) return { kind: 'output', output }
  if (retry !== undefined && input.tool === 'create_agent' && prompt.state !== retry.state) return { kind: 'invalid' }
  if (retry?.action === 'decline' || retry?.action === 'cancel') return { kind: 'closed', url: prompt.url }
  if (retry !== undefined && input.tool === 'create_agent') {
    const status = await input.setupStatus(prompt.state)
    if (Schema.is(SetupStatus)(status) && status.result.state === 'failed') return { kind: 'output', output: status }
  }
  return { kind: 'input', result: inputRequired(prompt) }
}

/** A create_agent retry after the operator approved: this connection now acts as that agent, so the call is done. */
export function settledCreation(params: Record<string, unknown>, tool: string, grant: OAuthGrant) {
  const retry = mrtrRetry(params)
  if (tool !== 'create_agent' || retry === undefined || grant.setup === true || !grant.agentIds.includes(retry.state))
    return undefined
  const result = { ok: true, result: { agentKey: retry.state, agentId: grant.registryAgentId, state: 'ready' } }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
}
