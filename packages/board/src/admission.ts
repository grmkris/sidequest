export const readOnlyHostedTools = new Set([
  'list_messages',
  'list_gaps',
  'list_roadmap',
  'get_roadmap_item',
  'list_roles',
  'protocol_info',
  'whoami',
  'setup_status',
  'list_tasks',
  'get_task',
  'list_quote_requests',
  'list_quotes',
  'get_budget',
  'task_index',
  'list_applications',
  'list_disputes',
  'get_dispute_bundle',
  'settlement_actions',
  'list_boards',
  'get_board',
  'auth_challenge',
  'auth_login',
  'list_directory',
  'get_directory_agent',
  'telegram_status',
  'sponsor_status',
  'sponsor_operation',
  'get_stake',
  'list_delegations',
  'fee_quote',
  'collect_actions',
  'mining_proof',
])

export const drainHostedTools = new Set([
  'submit_work',
  'report_transaction',
  'approve_work',
  'reject_work',
  'dispute',
  'add_statement',
  'request_evidence',
  'arbiter_lease',
  'prepare_ruling',
  'submit_ruling',
  'cancel_ruling',
  'revoke_budget',
  'cancel_task',
  'sponsor_revoke',
  'report_operation',
])

export const recoveryHostedTools = new Set([
  'submit_work',
  'report_transaction',
  'approve_work',
  'reject_work',
  'dispute',
  'add_statement',
  'request_evidence',
  'arbiter_lease',
  'prepare_ruling',
  'submit_ruling',
  'cancel_ruling',
  'revoke_budget',
  'cancel_task',
  'sponsor_revoke',
  'report_operation',
])

/**
 * Every tool which can reach the hosted board.  Production admission is open, but an
 * unknown tool must still fail closed instead of becoming a write by accident.
 * Keep this list alongside the API tool registry when adding a new hosted tool.
 */
export const hostedToolNames = new Set([
  'set_backer_share',
  'post_message',
  'report_gap',
  'propose_item',
  'support_item',
  'withdraw_support',
  'hide_content',
  'unhide_content',
  'set_item_status',
  'merge_items',
  'merge_gaps',
  'link_gaps',
  'set_gap_status',
  ...readOnlyHostedTools,
  ...drainHostedTools,
  'auth_challenge',
  'auth_login',
  'whoami',
  'create_agent',
  'create_task',
  'request_quotes',
  'submit_quote',
  'pick_quote',
  'spend_budget',
  'spend_budget_call',
  'upgrade_account',
  'budget_grant_prepare',
  'budget_grant_confirm',
  'get_budget',
  'revoke_budget',
  'report_transaction',
  'list_applications',
  'select_worker',
  'submit_selection',
  'publish_transactions',
  'cancel_task',
  'approve_work',
  'reject_work',
  'apply',
  'prepare_activation',
  'build_activation',
  'submit_work',
  'dispute',
  'add_statement',
  'request_evidence',
  'arbiter_lease',
  'prepare_ruling',
  'submit_ruling',
  'cancel_ruling',
  'settlement_actions',
  'list_boards',
  'get_board',
  'create_board',
  'update_board',
  'prepare_agent_profile',
  'update_profile',
  'prepare_directory_enrollment',
  'enroll_directory',
  'prepare_heartbeat',
  'post_heartbeat',
  'prepare_service_ad',
  'publish_service_ad',
  'prepare_revoke_service_ad',
  'revoke_service_ad',
  'telegram_status',
  'telegram_link_prepare',
  'telegram_link_confirm',
  'telegram_unlink',
  'sponsor_status',
  'sponsor_prepare',
  'sponsor_confirm',
  'sponsor_revoke',
  'sponsor_submit',
  'sponsor_operation',
  'top_up',
  'stake',
  'request_unstake',
  'cancel_unstake',
  'withdraw_stake',
  'get_stake',
  'fee_quote',
  'collect_actions',
])

export interface HostedAdmission {
  readonly drain: boolean
}

export const openAdmission: HostedAdmission = { drain: false }

/** Missing or malformed runtime values drain; admission is otherwise open. */
export function parseHostedAdmission(drain: string): HostedAdmission {
  return { drain: drain !== '0' && drain.toLowerCase() !== 'false' }
}

export function admissionFailure(
  admission: HostedAdmission,
  network: string,
  _board: string,
  tool: string,
  caller: string | undefined,
  stage?: string,
): string | undefined {
  if ((network !== 'monad-mainnet' && stage !== 'prod') || readOnlyHostedTools.has(tool)) return undefined
  if (!hostedToolNames.has(tool)) return 'unknown hosted tool'
  if (admission.drain && !drainHostedTools.has(tool)) return 'production hosted writes are in drain mode'
  if (recoveryHostedTools.has(tool) && caller !== undefined) return undefined
  if (admission.drain && drainHostedTools.has(tool)) return 'production recovery requires an authenticated wallet'
  if (admission.drain) return 'production hosted writes are in drain mode'
  if (caller === undefined || !/^0x[0-9a-fA-F]{40}$/.test(caller))
    return 'production hosted admission requires an authenticated wallet'
  return undefined
}

export function hostedTargetBoard(board: string, tool: string, args: Record<string, unknown>): string {
  if (tool === 'create_board') return typeof args.slug === 'string' ? args.slug : ''
  if (tool === 'update_board') return typeof args.boardId === 'string' ? args.boardId : board
  return board
}
