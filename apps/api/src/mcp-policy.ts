/** OAuth scopes are checked by both discovery and the Durable Object executing the action. */
import type { OAuthGrant } from './oauth.ts'
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
  'list_quotes',
  'get_budget',
  'list_applications',
  'get_stake',
  'list_delegations',
  'fee_quote',
  'mining_proof',
  'list_boards',
  'get_board',
  'list_directory',
  'find_services',
  'get_directory_agent',
  'list_approvals',
  'agent_status',
  'get_supported_permissions',
  'get_permissions',
  'inbox',
  'check_operation',
  'show_hiring_dashboard',
  'show_task',
  'update_profile',
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
  'set_backer_share',
  'use_permission',
  'revoke_permission',
])
/** Either side of a job: settle what is due, and state its case to the arbitrator (a hirer answers a dispute too). */
const SHARED_TOOLS = new Set(['settlement_actions', 'add_statement', ...commonsWriteTools])
export const SETUP_TOOLS = new Set(['whoami', 'create_agent', 'setup_status', 'find_services'])

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
  list_quotes: [true, false, true],
  get_budget: [true, false, true],
  list_applications: [true, false, true],
  get_stake: [true, false, true],
  list_delegations: [true, false, true],
  fee_quote: [true, false, true],
  mining_proof: [true, false, true],
  list_boards: [true, false, true],
  get_board: [true, false, true],
  list_directory: [true, false, true],
  find_services: [true, false, true],
  get_directory_agent: [true, false, true],
  list_approvals: [true, false, true],
  agent_status: [true, false, true],
  get_supported_permissions: [true, false, true],
  get_permissions: [true, false, true],
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
  settlement_actions: [false, true, true],
  request_unstake: [false, true, true],
  cancel_unstake: [false, true, true],
  withdraw_stake: [false, true, true],
  sweep_earnings: [false, true, true],
  request_permissions: [false, true, true],
  use_permission: [false, true, true],
  set_backer_share: [false, true, true],
  revoke_permission: [false, true, false],
}

export function toolAnnotations(name: string) {
  const review = REVIEW[name]
  if (review === undefined) throw new Error(`Missing MCP effect review for ${name}`)
  const [readOnlyHint, destructiveHint, idempotentHint] = review
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false }
}

/** Permissions on demand (ADR-0015) stay testnet-only until their mainnet promotion. */
export const PERMISSION_TOOLS = new Set([
  'set_backer_share',
  'get_supported_permissions',
  'get_permissions',
  'request_permissions',
  'use_permission',
  'revoke_permission',
])
/** A hosted agent's own directory listing (WS8) stays testnet-only until its signer rules reach mainnet. */
export const LISTING_TOOLS = new Set(['advertise_service', 'withdraw_service'])
/** x402 waits for the testnet routine signer policy; mainnet remains hidden. */
export const X402_TOOLS = new Set(['x402_pay'])

export function networkTool(network: string, name: string): boolean {
  return (
    network !== 'monad-mainnet' || (!PERMISSION_TOOLS.has(name) && !LISTING_TOOLS.has(name) && !X402_TOOLS.has(name))
  )
}
const CONTINUATIONS = new Set(['submit_selection', 'build_activation', 'report_transaction', 'report_operation'])

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
