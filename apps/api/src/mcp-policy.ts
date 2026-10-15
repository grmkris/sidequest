/** OAuth scopes are checked by both discovery and the Durable Object executing the action. */
import type { OAuthGrant } from './oauth.ts'
import { AGENT_ROLES, type AgentRole } from '@sidequest/board'
import { commonsReadTools, commonsWriteTools, toolSpecs } from '@sidequest/commons'

const READ_TOOLS = new Set([
  ...commonsReadTools,
  'get_instructions',
  'search_docs',
  'whoami',
  'protocol_info',
  'list_tasks',
  'get_task',
  'task_index',
  'list_quote_requests',
  'get_quote_request',
  'list_quotes',
  'get_budget',
  'list_applications',
  'get_dispute_bundle',
  'get_stake',
  'list_delegations',
  'fee_quote',
  'list_boards',
  'get_board',
  'list_directory',
  'find_services',
  'get_directory_agent',
  'list_approvals',
  'agent_status',
  'get_supported_permissions',
  'get_permissions',
  'prepare_gas_allowance',
  'edit_gas_allowance',
  'confirm_gas_allowance',
  'revoke_gas_allowance',
  'inbox',
  'check_operation',
  'show_hiring_dashboard',
  'show_task',
  'update_profile',
  // ADR-0021: any connection may ask for a role; only its operator's approval adds one.
  'request_role',
  // Any agent may ask its operator for SIDE backing; the operator backs it from their own wallet.
  'request_backing',
])
/** Hiring is publishing only: a host connection with hire alone cannot pay, move earnings or stake, or ask for wallet authority. */
const HIRE_TOOLS = new Set([
  'create_task',
  'request_quotes',
  'pick_quote',
  'select_worker',
  'cancel_task',
  'approve_work',
  'reject_work',
])
const WORK_TOOLS = new Set([
  'apply',
  'submit_quote',
  'prepare_activation',
  'submit_work',
  'dispute',
  'advertise_service',
  'withdraw_service',
  'x402_pay',
  'request_unstake',
  'cancel_unstake',
  'withdraw_stake',
  'sweep_earnings',
  'request_permissions',
  'use_permission',
  'revoke_permission',
])
/** Either side of a job: settle what is due, and state its case to the arbitrator (a hirer answers a dispute too). */
const SHARED_TOOLS = new Set(['settlement_actions', 'add_statement', ...commonsWriteTools])
/** A setup connection may read the docs it is told to read: MCP answers get_instructions and search_docs itself. */
export const SETUP_TOOLS = new Set([
  'whoami',
  'create_agent',
  'setup_status',
  'find_services',
  'get_instructions',
  'search_docs',
])

/** Hand-reviewed effects from tools.ts, runAgent and AgentExecutor (not inferred from scope).
 * Tool                       read   destructive  idempotent  effect
 * Reads below                true   false        true        chain/board lookup
 * create_task/pick_quote      false  true         true        escrow + signed selection continuation
 * request_quotes              false  false        true        public board record, no escrow
 * select_worker               false  true         true        signs binding Selection
 * approve_work/reject_work    false  true         true        payout / opens penalty dispute
 * cancel_task                 false  true         true        cancellation + refund settlement
 * settlement_actions          false  true         true        executor sends permissionless settlement
 * apply/submit_quote/statement false  false        true        board records
 * activation/submit/dispute   false  true         true        transaction / bonded liability
 * advertise/withdraw service  false  false/true   true        signed listing / revocation
 * permission request/use/stop false  true         true/true/false authority / execution / local stop
 * unstake/cancel/withdraw     false  true         true        vault transaction
 * sweep/x402                  false  true         true        transfer / signed payment
 * All effects are bounded to Sidequest, hence openWorldHint=false.
 */
const REVIEW: Readonly<Record<string, readonly [boolean, boolean, boolean]>> = {
  ...Object.fromEntries(Object.entries(toolSpecs).map(([name, spec]) => [name, spec.review])),
  show_hiring_dashboard: [true, false, false],
  show_task: [true, false, false],
  get_instructions: [true, false, true],
  search_docs: [true, false, true],
  whoami: [true, false, true],
  create_agent: [false, false, true],
  setup_status: [true, false, true],
  protocol_info: [true, false, true],
  list_tasks: [true, false, true],
  get_task: [true, false, true],
  task_index: [true, false, true],
  list_quote_requests: [true, false, true],
  get_quote_request: [true, false, true],
  list_quotes: [true, false, true],
  get_budget: [true, false, true],
  list_applications: [true, false, true],
  get_dispute_bundle: [true, false, true],
  get_stake: [true, false, true],
  list_delegations: [true, false, true],
  fee_quote: [true, false, true],
  list_boards: [true, false, true],
  get_board: [true, false, true],
  list_directory: [true, false, true],
  find_services: [true, false, true],
  get_directory_agent: [true, false, true],
  list_approvals: [true, false, true],
  agent_status: [true, false, true],
  get_supported_permissions: [true, false, true],
  get_permissions: [true, false, true],
  prepare_gas_allowance: [false, false, true],
  edit_gas_allowance: [false, false, true],
  confirm_gas_allowance: [false, true, true],
  revoke_gas_allowance: [false, true, true],
  inbox: [true, false, true],
  check_operation: [true, false, true],
  create_task: [false, true, true],
  request_quotes: [false, false, true],
  pick_quote: [false, true, true],
  select_worker: [false, true, true],
  cancel_task: [false, true, true],
  approve_work: [false, true, true],
  reject_work: [false, true, true],
  x402_pay: [false, true, true],
  apply: [false, false, true],
  submit_quote: [false, false, true],
  prepare_activation: [false, true, true],
  submit_work: [false, true, true],
  dispute: [false, true, true],
  add_statement: [false, false, true],
  advertise_service: [false, false, true],
  withdraw_service: [false, true, true],
  update_profile: [false, false, true],
  request_role: [false, false, true],
  request_backing: [true, false, true],
  settlement_actions: [false, true, true],
  request_unstake: [false, true, true],
  cancel_unstake: [false, true, true],
  withdraw_stake: [false, true, true],
  sweep_earnings: [false, true, true],
  request_permissions: [false, true, true],
  use_permission: [false, true, true],
  revoke_permission: [false, true, false],
  // Public directory signatures are the credential; prepare calls do not mutate directory state.
  prepare_agent_profile: [true, false, true],
  prepare_directory_enrollment: [true, false, true],
  enroll_directory: [false, false, true],
  prepare_service_ad: [true, false, true],
  publish_service_ad: [false, false, true],
  prepare_revoke_service_ad: [true, false, true],
  revoke_service_ad: [false, false, true],
  prepare_heartbeat: [true, false, true],
  post_heartbeat: [false, false, true],
}

export function toolAnnotations(name: string) {
  const review = REVIEW[name]
  if (review === undefined) throw new Error(`Missing MCP effect review for ${name}`)
  const [readOnlyHint, destructiveHint, idempotentHint] = review
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false }
}

/** Permissions on demand (ADR-0015) stay testnet-only until their mainnet promotion. */
export const PERMISSION_TOOLS = new Set([
  'get_supported_permissions',
  'get_permissions',
  'request_permissions',
  'use_permission',
  'revoke_permission',
])
/** A hosted agent's own directory listing (WS8); its ServiceAd and RevokeAd signer rules reached mainnet in the
 *  chain-143 Privy policy on 13 Oct, so listing runs on both networks. */
export const LISTING_TOOLS = new Set(['advertise_service', 'withdraw_service'])
export const PUBLIC_DIRECTORY_TOOLS = new Set([
  'find_services',
  'list_directory',
  'get_directory_agent',
  'prepare_agent_profile',
  'prepare_directory_enrollment',
  'enroll_directory',
  'prepare_service_ad',
  'publish_service_ad',
  'prepare_revoke_service_ad',
  'revoke_service_ad',
  'prepare_heartbeat',
  'post_heartbeat',
])
/** x402 waits for the testnet routine signer policy; mainnet remains hidden. */
export const X402_TOOLS = new Set(['x402_pay'])

export function networkTool(network: string, name: string): boolean {
  return network !== 'monad-mainnet' || (!PERMISSION_TOOLS.has(name) && !X402_TOOLS.has(name))
}
const CONTINUATIONS = new Set([
  'submit_selection',
  'build_activation',
  'report_transaction',
  'report_operation',
  'release_pick',
])
/**
 * What the hosted executor may run for an operator on the agent's behalf, outside any OAuth connection. `release_pick`
 * reopens a quote request after the operator declines its over-budget pick.
 */
export const OPERATOR_CONTINUATIONS = new Set([
  'request_unstake',
  'withdraw_stake',
  'report_transaction',
  'report_operation',
  'release_pick',
])

export function requiredToolScope(
  name: string,
): 'sidequest:read' | 'sidequest:hire' | 'sidequest:work' | 'sidequest:setup' | 'write' | undefined {
  if (name === 'create_agent' || name === 'setup_status') return 'sidequest:setup'
  if (READ_TOOLS.has(name)) return 'sidequest:read'
  if (HIRE_TOOLS.has(name)) return 'sidequest:hire'
  if (WORK_TOOLS.has(name)) return 'sidequest:work'
  if (SHARED_TOOLS.has(name)) return 'write'
  return undefined
}

/**
 * Tools that start new work of a role (ADR-0021). Without the role an agent cannot start more, but finishing,
 * settling and moving money out stay with its scope, so work it already took on or posted can still end.
 */
const STARTS: Readonly<Record<AgentRole, ReadonlySet<string>>> = {
  work: new Set([
    'apply',
    'submit_quote',
    'prepare_activation',
    'advertise_service',
    'x402_pay',
    'request_permissions',
    'use_permission',
  ]),
  hire: new Set(['create_task', 'request_quotes', 'pick_quote', 'select_worker']),
}

type PolicyGrant = Pick<OAuthGrant, 'scopes' | 'setup' | 'setupFamilyId' | 'roles' | 'listening'>

/**
 * One answer for listing, calling and executing a tool: the connection's scope first, then its agent's roles. `wait`
 * is a setup connection asking for a tool its agent gets once approved; `role` a tool that starts work of a role the
 * agent does not hold. A grant without roles predates them and is decided by scope alone.
 */
export function toolDecision(grant: PolicyGrant, name: string, internal = false): 'allow' | 'wait' | 'role' | 'scope' {
  if (!permittedTool(grant, name, internal)) return awaitsApproval(grant, name) ? 'wait' : 'scope'
  const role = AGENT_ROLES.find((candidate) => STARTS[candidate].has(name))
  return role === undefined || grant.roles === undefined || grant.roles.includes(role) ? 'allow' : 'role'
}

/** What this connection may do now: the roles its scope covers and its agent holds. */
export function effectiveRoles(grant: PolicyGrant): AgentRole[] {
  return AGENT_ROLES.filter(
    (role) => grant.scopes.includes(`sidequest:${role}`) && (grant.roles === undefined || grant.roles.includes(role)),
  )
}

/**
 * What a connection lists. A connection that listens for tool changes lists exactly what it may call now, because it
 * is told the moment that changes. Any other connection lists everything its scope covers, as clients cache the list:
 * a setup connection also lists the tools its approved agent may get, and a tool its agent lacks the role for stays
 * listed and answers with how to ask for the role. Either way, a tool of a role the agent holds beyond the sign-in's
 * scope is listed so that a call can step up.
 */
export function listedTool(grant: PolicyGrant, name: string): boolean {
  if (stepsUp(grant, name)) return true
  if (grant.listening === true) return toolDecision(grant, name) === 'allow'
  return permittedTool(grant, name) || awaitsApproval(grant, name)
}

/**
 * A tool of a role the agent holds that this connection's sign-in does not cover. It is listed, so that calling it
 * answers MCP's step-up (403 insufficient_scope) and the client can ask its user for that scope: otherwise a role the
 * operator granted later could never reach a connection that signed in narrower.
 */
function stepsUp(grant: PolicyGrant, name: string): boolean {
  if (grant.setup === true || grant.roles === undefined || toolDecision(grant, name) !== 'scope') return false
  const scope = requiredToolScope(name)
  if (scope === 'write') return grant.roles.length > 0
  return grant.roles.some((role) => scope === `sidequest:${role}`)
}

/** What a setup connection is told while its operator has not approved its agent yet. */
export const SETUP_WAITING =
  'waiting: this connection has no approved agent yet. Call whoami: create_agent proposes one for your operator to approve; to use an agent they already have, they reconnect Sidequest in this app and pick it at sign-in.'

/**
 * Why a connection may not call a tool, or undefined when it may: a tool result to answer with, or the scope a client
 * must step up to (MCP's 403 insufficient_scope). A setup connection asking for a tool its agent gets once approved is
 * told to wait, and a missing role names request_role: signing in again fixes neither.
 */
export function toolRefusal(
  grant: PolicyGrant,
  name: string,
): { readonly result: Record<string, unknown> } | { readonly stepUp: string } | undefined {
  const decision = toolDecision(grant, name)
  if (decision === 'allow') return undefined
  if (decision === 'role') return { result: roleRefusal(AGENT_ROLES.find((role) => STARTS[role].has(name))!) }
  if (decision === 'wait')
    return {
      result: {
        content: [
          {
            type: 'text',
            text: `${SETUP_WAITING} Poll setup_status; this tool works on this connection once it reports ready.`,
          },
        ],
        isError: true,
      },
    }
  const scope = requiredToolScope(name)
  if (scope === undefined || scope === 'sidequest:setup')
    return {
      result: {
        content: [{ type: 'text', text: `not-found: this connection has no tool ${name}` }],
        isError: true,
      },
    }
  // A tool either side may call needs the scope of a role the agent holds.
  const needed =
    scope === 'write' ? (grant.roles?.length ? grant.roles : AGENT_ROLES).map((role) => `sidequest:${role}`) : [scope]
  return { stepUp: [...new Set([...grant.scopes, ...needed])].join(' ') }
}

const ROLE_WORDS: Readonly<Record<AgentRole, string>> = { work: 'take on new work', hire: 'hire other agents' }

/** A tool its agent lacks the role for: a plain tool error that names the way forward, never a sign-in prompt. */
function roleRefusal(role: AgentRole) {
  return {
    content: [
      {
        type: 'text',
        text: `role-required: your operator has not allowed this agent to ${ROLE_WORDS[role]}. Call request_role with {"role":"${role}"} to ask; work it already started can still finish.`,
      },
    ],
    structuredContent: { ok: false, code: 'role-required', role, next: { tool: 'request_role', args: { role } } },
    isError: true,
  }
}

/** A setup connection's call to a tool it gets only once its operator approves the agent. */
function awaitsApproval(grant: Pick<OAuthGrant, 'scopes' | 'setup' | 'setupFamilyId'>, name: string): boolean {
  const scope = requiredToolScope(name)
  return grant.setup === true && !permittedTool(grant, name) && scope !== undefined && scope !== 'sidequest:setup'
}

export function permittedTool(
  grant: Pick<OAuthGrant, 'scopes' | 'setup' | 'setupFamilyId'>,
  name: string,
  internal = false,
): boolean {
  if (grant.setup === true) return grant.scopes.includes('sidequest:setup') && SETUP_TOOLS.has(name)
  if (name === 'setup_status') return grant.setupFamilyId !== undefined
  if (name === 'create_agent') return false
  if (internal && CONTINUATIONS.has(name))
    return grant.scopes.includes('sidequest:hire') || grant.scopes.includes('sidequest:work')
  const scope = requiredToolScope(name)
  if (scope === 'write') return grant.scopes.includes('sidequest:hire') || grant.scopes.includes('sidequest:work')
  return scope !== undefined && grant.scopes.includes(scope)
}
