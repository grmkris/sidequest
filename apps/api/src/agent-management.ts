/** Private management RPC: SIWE controls decisions; Privy binds server wallet creation to its owner. */
import {
  AgentLifecycle,
  AgentOnboarding,
  AgentRegistration,
  AgentSigning,
  AgentStore,
  agentRoles,
  BoardError,
  GrantStore,
  RelaySender,
  SponsorDesk,
  errorDiagnostics,
  type AgentOperationRow,
  type ApprovalRow,
  type Sql,
} from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { type Address, type Hex, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { privyOperator } from './privy-operator.ts'
import { fromD1 } from '@sidequest/indexer'
import { decisionFeedEvents, recordAgentEvents } from './feed-agent.ts'
import { terminateSubscriptions } from './webhooks.ts'
import type { AgentRouteRequest } from './routes/agents.ts'
import { ownerAgentSetup } from './agent-setup-owner.ts'
import { agentAccess } from './agent-access.ts'
import { agentProfileManagement } from './agent-profile-management.ts'
import { hostedUserOpDesk } from './agent-userop.ts'
import { agentGasAllowance } from './agent-gas-allowance.ts'
import { agentBalances } from './agent-balances.ts'
import { approvalDetails } from './approval-details.ts'
import { manageWorkloadPolicies } from './workload-policies.ts'

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000)
    throw new BoardError('invalid', `Require ${key}`)
  return value
}

function hex(body: Record<string, unknown>, key: string, size: number): Hex {
  const value = text(body, key)
  if (!new RegExp(`^0x[0-9a-fA-F]{${size}}$`).test(value)) throw new BoardError('invalid', `Invalid ${key}`)
  return value as Hex
}

/** Runs one agent operation for its operator (approve, retry, or release a declined pick). */
type ExecuteForOperator = (
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  key: string,
  approvalId?: string,
  boardId?: string,
) => Promise<unknown>

export async function agentManagement(input: {
  readonly request: AgentRouteRequest
  readonly sql: Sql
  readonly context: sdk.Ctx
  readonly operator: Address
  readonly privyToken?: string
  readonly bindings: Record<string, unknown>
  readonly relayKey: Hex
  readonly rpcUrl: string
  readonly now: () => number
  readonly execute: ExecuteForOperator
}) {
  const { request, sql, context, operator, bindings, now } = input
  const { action, body } = request
  const id = request.id ?? ''
  const agents = new AgentStore(sql, now)
  if (['workload-policies', 'workload-policy-add', 'workload-policy-change'].includes(action))
    return manageWorkloadPolicies({ sql, agentId: id, operator, action, body, bindings, now: now() })
  if (action === 'balances') {
    const agent = agents.owned(id, operator)
    if (agent.address === null) throw new BoardError('unavailable', 'This agent wallet is not ready')
    return agentBalances(
      context,
      // SAFETY: Database is the Cloudflare D1 binding configured by this Worker.
      bindings.Database === undefined ? undefined : fromD1(bindings.Database as never),
      agent.address,
    )
  }
  if (action === 'profile' || action === 'avatar' || action === 'avatar-generate') return agentProfileManagement(input)
  if (action === 'registration-record') {
    return new AgentRegistration({ sql, context, now }).record(id, operator, hex(body, 'txHash', 64))
  }
  if (action === 'setup-identity' || action === 'approve') return ownerAgentSetup(input)
  if (action === 'roles' || action === 'connections' || action === 'disconnect') return agentAccess(input)
  const sponsor = new SponsorDesk({
    sql,
    ctx: context,
    now,
    ...(/^0x[0-9a-fA-F]{64}$/.test(input.relayKey)
      ? { relay: { account: privateKeyToAccount(input.relayKey), rpcUrl: input.rpcUrl } }
      : {}),
    fail: (code, message) => new BoardError(code, message),
  })
  const hostedMode = sdk.hostedSendMode(
    context.deployment.network,
    Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.String))(bindings.HOSTED_SEND),
  )
  const lifecycle = new AgentLifecycle({
    sql,
    context,
    now,
    sponsor,
    ...(hostedMode === 'userop' ? { hostedSend: 'userop' } : {}),
  })
  if (action === 'list')
    return {
      agents: agents.list(operator, context.deployment.chainId).map((row) => ({ ...row, roles: agentRoles(row) })),
    }
  if (action === 'approvals')
    return { approvals: agents.approvals(operator).map((row) => approvalDetails(agents, row)) }
  if (action === 'status') return lifecycle.status(id, operator)
  if (action === 'recovery') {
    const agent = agents.owned(id, operator)
    const grants = new GrantStore(sql, context)
    return {
      agent,
      grants: [...grants.list(operator), ...grants.list(agent.address ?? operator)]
        .filter((row) => {
          const spec = grants.spec(row.delegation_hash)
          return (
            row.delegator.toLowerCase() === agent.address?.toLowerCase() ||
            ((spec.kind === 'allowance' ||
              spec.kind === 'gas-allowance' ||
              spec.kind === 'allowance-once' ||
              spec.kind === 'permission') &&
              spec.agent.toLowerCase() === agent.address?.toLowerCase())
          )
        })
        .map((row) => ({
          hash: row.delegation_hash,
          delegation: sdk.parseDelegation(row.delegation_json),
          status: row.status,
        })),
    }
  }
  if (action === 'allowance-prepare') {
    const token = text(body, 'token')
    const amount = text(body, 'amount')
    if (!isAddress(token) || !/^[1-9][0-9]{0,77}$/.test(amount))
      throw new BoardError('invalid', 'Invalid allowance token or amount')
    return lifecycle.prepareAllowance(id, operator, { key: text(body, 'key'), token, amount: BigInt(amount) })
  }
  if (action === 'allowance-confirm')
    return lifecycle.confirmAllowance(
      id,
      operator,
      text(body, 'key'),
      hex(body, 'hash', 64),
      hex(body, 'signature', 130),
    )
  if (action.startsWith('gas-allowance-')) return agentGasAllowance({ lifecycle, id, operator, action, body })
  if (action === 'stop-access' || action === 'revoke') {
    // Stopping hosted access is authoritative and comes first. Then the agent's event webhooks end: the revocation is
    // recorded where subscribe and delivery check it. Both steps are idempotent, so if the second fails the operator
    // repeats the request (VV2-030).
    const agent = lifecycle.stopAccess(id, operator)
    if (agent.address !== null && bindings.Database !== undefined) {
      try {
        await terminateSubscriptions(fromD1(bindings.Database as never), agent.address, now())
      } catch {
        throw new BoardError(
          'unavailable',
          'Hosted access is stopped, but its event webhooks have not ended yet. Repeat this request.',
        )
      }
    }
    return action === 'stop-access' ? agent : lifecycle.revoke(id, operator)
  }
  if (action === 'approval-prepare') {
    // A permission approval may be adjusted before signing: a shorter expiry or a lower amount, never wider.
    const expiry = body.expiry === undefined ? undefined : Number(body.expiry)
    const amount = body.amount === undefined ? undefined : text(body, 'amount')
    if (
      (expiry !== undefined && !Number.isSafeInteger(expiry)) ||
      (amount !== undefined && !/^[1-9][0-9]{0,77}$/.test(amount))
    )
      throw new BoardError('invalid', 'Invalid permission adjustment')
    return lifecycle.prepareApproval(id, operator, {
      ...(expiry === undefined ? {} : { expiry }),
      ...(amount === undefined ? {} : { amount: BigInt(amount) }),
    })
  }
  if (action === 'approval-decide' || action === 'approval-retry') {
    const approval =
      action === 'approval-decide'
        ? await lifecycle.decideApproval(
            id,
            operator,
            body.approved === true,
            body.signature === undefined ? undefined : hex(body, 'signature', 130),
            {
              ...(body.hash === undefined ? {} : { hash: hex(body, 'hash', 64) }),
              ...(body.standing === undefined ? {} : { standing: body.standing === true }),
            },
          )
        : lifecycle.recoverApproval(id, operator)
    const agent = agents.owned(approval.agent_id, operator)
    const operation = agents.operation(approval.operation_id)
    // A declined pick's request is released before the agent is told, so the notice says what actually happened.
    const reopen = approval.status === 'approved' ? {} : await reopenDeclinedPick(approval, operation, input.execute)
    if (action === 'approval-decide')
      await recordAgentEvents(
        bindings.Database === undefined ? undefined : fromD1(bindings.Database as never),
        context.deployment.network,
        operator,
        decisionFeedEvents(context.deployment.network, agent, approval, operation, {
          now: now(),
          reopened: reopen.reopened,
        }),
        now(),
      )
    if (approval.status !== 'approved') return { approval, ...reopen }
    return input.execute(
      agent.id,
      operation.tool,
      JSON.parse(operation.intent_json) as Record<string, unknown>,
      operation.action_key,
      approval.id,
      operation.board_id,
    )
  }
  if (action === 'execute') {
    const agent = agents.owned(id, operator)
    const tool = text(body, 'tool')
    if (
      ![
        'sweep_earnings',
        'request_unstake',
        'withdraw_stake',
        'check_operation',
        'withdraw_service',
        'revoke_permission',
      ].includes(tool)
    )
      throw new BoardError('forbidden', 'This website action is unavailable')
    const args = typeof body.args === 'object' && body.args !== null ? (body.args as Record<string, unknown>) : {}
    return input.execute(agent.id, tool, args, text(body, 'operationKey'))
  }
  const appSecret = String(bindings.PRIVY_APP_SECRET ?? '')
  const signerKey = String(bindings.PRIVY_SIGNER_KEY ?? '')
  if (appSecret === '' || appSecret === 'unset' || signerKey === '' || signerKey === 'unset')
    throw new BoardError('unavailable', 'Privy agent management is unavailable')
  const provider = new sdk.PrivyServer({
    appId: String(bindings.PRIVY_APP_ID ?? ''),
    appSecret,
    sign: await sdk.p256AuthorizationSigner(signerKey),
  })
  if (action === 'registration-batch')
    return new AgentRegistration({
      sql,
      context,
      now,
      publicOrigin: Schema.decodeUnknownSync(Schema.String)(bindings.PUBLIC_ORIGIN ?? ''),
      signing: new AgentSigning(sql, context, provider, now),
    }).prepare(id, operator, body.operationKey === undefined ? 'registration-batch' : text(body, 'operationKey'))
  if (action === 'signer-removed') {
    const agent = agents.owned(id, operator)
    if (agent.state !== 'revoked' || agent.privy_wallet_id === null)
      throw new BoardError('conflict', 'Stop hosted access first')
    const wallet = await provider.getWallet(agent.privy_wallet_id)
    if (
      wallet.address.toLowerCase() !== agent.address?.toLowerCase() ||
      wallet.signers.some((signer) => signer.signerId === bindings.PRIVY_SIGNER_ID)
    )
      throw new BoardError('conflict', 'Privy has not confirmed removal of the routine signer')
    sql.run(
      'UPDATE agents SET revoke_json=? WHERE id=?',
      JSON.stringify({ ...JSON.parse(agent.revoke_json), signerRemoved: true, signerRemovedAt: now() }),
      id,
    )
    return lifecycle.status(id, operator)
  }
  const signing = new AgentSigning(sql, context, provider, now)
  const submitter = hostedUserOpDesk({ bindings, sql, context, signing, now })
  if (submitter === undefined && !/^0x[0-9a-fA-F]{64}$/.test(input.relayKey))
    throw new BoardError('unavailable', 'The relay is unavailable')
  const onboarding = new AgentOnboarding({
    sql,
    context,
    now,
    publicOrigin: Schema.decodeUnknownSync(Schema.String)(bindings.PUBLIC_ORIGIN ?? ''),
    sponsor,
    signing,
    ...(submitter === undefined ? {} : { submitter }),
    signerId: String(bindings.PRIVY_SIGNER_ID ?? ''),
    policyId: String(bindings.PRIVY_POLICY_ID ?? ''),
    ...(submitter === undefined
      ? { relay: new RelaySender(sql, context, privateKeyToAccount(input.relayKey), input.rpcUrl, now) }
      : {}),
  })
  if (action === 'create') {
    if (input.privyToken === undefined) throw new BoardError('unauthenticated', 'A current Privy session is required')
    const userId = await privyOperator({
      token: input.privyToken,
      appId: String(bindings.PRIVY_APP_ID ?? ''),
      appSecret,
      operator,
      now: now(),
    })
    if (userId === undefined)
      throw new BoardError('forbidden', 'The Privy user does not own this embedded operator wallet')
    return onboarding.create({ id: text(body, 'id'), operator, userId, name: text(body, 'name') }, provider)
  }
  agents.owned(id, operator)
  if (action === 'resume') return onboarding.resume(id)
  if (action === 'registration-prepare') return onboarding.prepareRegistration(id, operator)
  if (action === 'registration-confirm')
    return onboarding.register(id, operator, hex(body, 'hash', 64), hex(body, 'signature', 130))
  throw new BoardError('not-found', 'No such agent lifecycle action')
}

/**
 * A declined over-budget pick reopens its quote request at once, rather than on the agent's next call: running the
 * declined operation makes the executor release the never-published pick. Never fails the decision.
 */
export async function reopenDeclinedPick(
  approval: Pick<ApprovalRow, 'id' | 'kind' | 'status' | 'agent_id'>,
  operation: Pick<AgentOperationRow, 'tool' | 'intent_json' | 'action_key' | 'board_id'>,
  execute: ExecuteForOperator,
): Promise<{ reopened?: boolean }> {
  if (approval.status !== 'rejected' || approval.kind !== 'hire-over-limit' || operation.tool !== 'pick_quote')
    return {}
  try {
    const result = await execute(
      approval.agent_id,
      operation.tool,
      // SAFETY: an operation's intent is the JSON object of the arguments it was begun with.
      JSON.parse(operation.intent_json) as Record<string, unknown>,
      operation.action_key,
      approval.id,
      operation.board_id,
    )
    return { reopened: result instanceof Object && 'next' in result }
  } catch (error) {
    console.error(JSON.stringify({ event: 'pick-reopen-failed', approvalId: approval.id, ...errorDiagnostics(error) }))
    return { reopened: false }
  }
}
