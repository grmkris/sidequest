/** The reserved management object's MCP and operator action runtime. */
import {
  AgentDirectory,
  AgentStore,
  AgentSigning,
  AgentExecutor,
  AgentLifecycle,
  AgentPermissions,
  AgentRoles,
  BoardError,
  canonicalAgentId,
  type AgentExecuteResult,
  type AgentRow,
  SponsorDesk,
  failureFromReply,
  migrateAgentSchema,
  SPONSOR_OBJECT_NAME,
  type Sql,
} from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, encodeFunctionData, erc20Abi, isHex } from 'viem'
import { Schema } from 'effect'
import { privateKeyToAccount } from 'viem/accounts'
import type { BoardCall, BoardReply } from './board.ts'
import { resolveOAuth } from './oauth.ts'
import { networkTool, requiredToolScope, SETUP_TOOLS, toolDecision } from './mcp-policy.ts'
import { resourceBoard } from './oauth-validation.ts'
import { toJson } from './tools.ts'
import { fromD1 } from '@sidequest/indexer'
import { publishAgentOffer, type OfferBucket } from './agent-offers.ts'
import { tenantAgentRequest } from './agent-requests.ts'
import { reportRelayWatchFailure, watchRelay } from './relay-watch.ts'
import { agentFeedEvents, approvalUrl, recordAgentEvents } from './feed-agent.ts'
import { directoryAudience, directoryPort } from './directory-object.ts'
import { managedProfileUpdates, profileOperationKey } from './agent-profiles.ts'
import { uploadSample } from './agent-samples.ts'
import type { AvatarBucket } from './avatars.ts'
import { runSetupTool } from './agent-setup.ts'
import { BackingRequestInput, chainBackingReads, requestBacking } from './agent-backing-request.ts'
import { publicOrigin } from './telegram.ts'
import { objectFor } from './commons/route.ts'
import { hostedUserOpDesk } from './agent-userop.ts'
import { agentGasAllowance } from './agent-gas-allowance.ts'
import { agentBalances } from './agent-balances.ts'
import { approvalDetails } from './approval-details.ts'

const key32 = (key: string) => /^0x[0-9a-fA-F]{64}$/.test(key)

const RoleRequestInput = Schema.Struct({
  role: Schema.Literals(['work', 'hire']),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(280))),
})

/**
 * An executed action's answer: inbox rows for the agent and its operator (never failing the action), and for an
 * approval the operator's signing link, so the agent can forward it instead of asking how.
 */
async function answered(
  input: { network: sdk.Network; bindings: Record<string, unknown>; agent: AgentRow; tool: string; key: string },
  result: AgentExecuteResult,
) {
  const { network, bindings, agent, tool, key } = input
  const now = Math.floor(Date.now() / 1000)
  await recordAgentEvents(
    bindings.Database === undefined ? undefined : fromD1(bindings.Database as never),
    network,
    agent.operator,
    agentFeedEvents({ network, agent, tool, operationKey: key, result, now }),
    now,
  )
  return toJson({
    ok: true,
    result:
      result.status === 'approval'
        ? { ...result, approveUrl: approvalUrl(network, agent, result.approval.id) }
        : result,
  })
}

export interface AgentExecuteRequest {
  env: BoardCall['env']
  tool: string
  args: Record<string, unknown>
  agentId: string
  resource: string
  bearer?: string
  ip?: string
  operator?: Address
}

const runsOn = (_work: Promise<void>) => undefined

export async function runAgent(runtime: {
  req: AgentExecuteRequest
  bindings: Record<string, unknown>
  sql: Sql
  stateId: string
  /** Work that outlives the answer; outside a Durable Object it simply runs on. */
  background?: (work: Promise<void>) => void
}): Promise<string> {
  const { req, bindings, sql } = runtime
  const namespace = bindings.Board as {
    idFromName(name: string): { toString(): string }
    get(id: unknown): {
      call(req: BoardCall): Promise<string>
      verifyAgentSigning(req: BoardCall & { typedData: string }): Promise<string>
    }
  }
  if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== runtime.stateId || req.env.network !== bindings.NETWORK)
    throw new BoardError('forbidden', 'management object identity mismatch')
  if (!networkTool(req.env.network, req.tool))
    throw new BoardError('forbidden', 'This tool is not available on this network yet')
  migrateAgentSchema(sql)
  if (req.operator === undefined) {
    const grant = await resolveOAuth(sql, req.bearer, req.resource, Math.floor(Date.now() / 1000))
    const decision = grant === undefined ? 'scope' : toolDecision(grant, req.tool)
    if (
      grant === undefined ||
      (grant.setup === true ? !SETUP_TOOLS.has(req.tool) : !grant.agentIds.includes(req.agentId)) ||
      (decision !== 'allow' && decision !== 'role') ||
      resourceBoard(req.resource, new URL(req.resource).origin) !== req.env.boardId
    )
      throw new BoardError('forbidden', 'This connection does not grant this agent, tool or board')
    if (decision === 'role')
      throw new BoardError(
        'forbidden',
        'role-required: the operator has not allowed this agent this role; call request_role',
      )
    if (grant.setup === true || req.tool === 'setup_status')
      return toJson({
        ok: true,
        result: await runSetupTool({ req, bindings, sql, grant, background: runtime.background ?? runsOn }),
      })
  }
  const agents = new AgentStore(sql, () => Math.floor(Date.now() / 1000))
  const agent = req.operator === undefined ? agents.get(req.agentId) : agents.owned(req.agentId, req.operator)
  agents.touch(agent.id)
  const { operationKey, managedAgentId: _managedAgentId, ...args } = req.args
  if (requiredToolScope(req.tool) !== 'sidequest:read' && typeof operationKey !== 'string')
    throw new BoardError('invalid', 'Every write requires a stable operationKey; retry with the same key')
  if (req.tool === 'apply' || req.tool === 'submit_quote') {
    if (
      args.agentId !== undefined &&
      // SAFETY: canonicalAgentId stringifies and pattern-checks the value, refusing any other JSON value as invalid.
      canonicalAgentId(args.agentId as string | number) !== agent.agent_id
    )
      throw new BoardError('forbidden', "Use this connection's registered agentId")
    args.agentId = agent.agent_id
  }
  const ctx = sdk.context(req.env.network, 'main', req.env.rpcUrl)
  if (req.tool === 'get_balances') {
    if (agent.address === null) throw new BoardError('unavailable', 'This agent wallet is not ready')
    return toJson({
      ok: true,
      result: await agentBalances(
        ctx,
        // SAFETY: Database is the Cloudflare D1 binding configured by this Worker.
        bindings.Database === undefined ? undefined : fromD1(bindings.Database as never),
        agent.address,
      ),
    })
  }
  const sponsor = new SponsorDesk({
    sql,
    ctx,
    now: () => Math.floor(Date.now() / 1000),
    ...(key32(req.env.relayKey)
      ? { relay: { account: privateKeyToAccount(req.env.relayKey as Hex), rpcUrl: req.env.rpcUrl } }
      : {}),
    fail: (code, message) => new BoardError(code, message),
  })
  const signerKey = typeof bindings.PRIVY_SIGNER_KEY === 'string' ? bindings.PRIVY_SIGNER_KEY : ''
  const appSecret = typeof bindings.PRIVY_APP_SECRET === 'string' ? bindings.PRIVY_APP_SECRET : ''
  const provider = new sdk.PrivyServer({
    appId: String(bindings.PRIVY_APP_ID ?? ''),
    appSecret,
    sign: async (payload) => {
      if (signerKey === '' || signerKey === 'unset')
        throw new BoardError('unavailable', 'Hosted agent signing is unavailable')
      return (await sdk.p256AuthorizationSigner(signerKey))(payload)
    },
  })
  const signing = new AgentSigning(sql, ctx, provider, () => Math.floor(Date.now() / 1000))
  const submitter = hostedUserOpDesk({ bindings, sql, context: ctx, signing, now: () => Math.floor(Date.now() / 1000) })
  const lifecycle = new AgentLifecycle({
    sql,
    context: ctx,
    now: () => Math.floor(Date.now() / 1000),
    sponsor,
    ...(submitter === undefined ? {} : { hostedSend: 'userop' }),
  })
  if (req.tool === 'agent_status')
    return toJson({
      ok: true,
      result: await lifecycle.status(agent.id, agent.operator),
    })
  if (req.tool === 'list_approvals')
    return toJson({
      ok: true,
      result: {
        approvals: agents
          .approvals(agent.operator)
          .filter((row) => row.agent_id === agent.id)
          .map((row) => approvalDetails(agents, row)),
      },
    })
  if (
    ['prepare_gas_allowance', 'edit_gas_allowance', 'confirm_gas_allowance', 'revoke_gas_allowance'].includes(req.tool)
  ) {
    const actions: Readonly<Record<string, string>> = {
      prepare_gas_allowance: 'gas-allowance-prepare',
      edit_gas_allowance: 'gas-allowance-edit',
      confirm_gas_allowance: 'gas-allowance-confirm',
      revoke_gas_allowance: 'gas-allowance-revoke',
    }
    return toJson({
      ok: true,
      result: await agentGasAllowance({
        lifecycle,
        id: agent.id,
        operator: agent.operator,
        action: actions[req.tool]!,
        body: args,
      }),
    })
  }
  const permissions = new AgentPermissions({ sql, context: ctx, now: () => Math.floor(Date.now() / 1000) })
  if (req.tool === 'get_supported_permissions')
    return toJson({ ok: true, result: sdk.supportedPermissions(ctx.deployment) })
  if (req.tool === 'get_permissions') return toJson({ ok: true, result: { permissions: permissions.list(agent) } })
  if (req.tool === 'revoke_permission') {
    const permissionId = permissionHash(args.permissionId)
    const result =
      req.operator === undefined
        ? permissions.stop(agent, permissionId)
        : await lifecycle.disablePermission(agent.id, req.operator, permissionId)
    return toJson({
      ok: true,
      result: req.operator === undefined || submitter !== undefined ? result : { status: 'confirmed', result },
    })
  }
  if (req.tool === 'check_operation') {
    // Prod gap 20: agents pass the operationKey they saved; an unknown one answered as an internal failure.
    const operation = agents.findOperation(agent.id, String(args.operationId ?? ''))
    if (operation === undefined)
      throw new BoardError(
        'not-found',
        'This agent has no operation with this operationId or operationKey. To learn what the original call did, send it again with the same arguments and operationKey.',
      )
    if (operation.agent_id !== agent.id) throw new BoardError('forbidden', 'Operation belongs to another agent')
    const result =
      operation.sponsor_operation_id === null
        ? ((await submitter?.operation(operation.id)) ?? operation)
        : await sponsor.operation(agent.address!, operation.sponsor_operation_id)
    return toJson({ ok: true, result })
  }
  if (req.tool === 'upload_sample') {
    // SAFETY: Manifests is this Worker's R2 binding (manifests.ts); its raw form stores and serves sample bytes.
    const bucket = bindings.Manifests as AvatarBucket | undefined
    return toJson({
      ok: true,
      result: await uploadSample({
        sql,
        now: () => Math.floor(Date.now() / 1000),
        origin: new URL(req.resource).origin,
        boardId: req.env.boardId,
        bucket,
        agentId: agent.id,
        key: profileOperationKey(operationKey),
        args,
      }),
    })
  }
  const prepare = (tool: string, input: Record<string, unknown>): BoardCall =>
    tenantAgentRequest(req, agent.address!, tool, input)
  const tenantFor = (tool: string) => namespace.get(namespace.idFromName(objectFor(tool, req.env.boardId)))
  const tenant = tenantFor(req.tool)
  if (req.tool === 'update_profile') {
    const key = profileOperationKey(operationKey)
    const updates = managedProfileUpdates({
      sql,
      now: () => Math.floor(Date.now() / 1000),
      origin: new URL(req.resource).origin,
      boardId: req.env.boardId,
      bindings,
      context: ctx,
      rpcUrl: req.env.rpcUrl,
    })
    return toJson({
      ok: true,
      result: await updates.update(agent.id, key, args, req.operator === undefined ? 'agent' : 'owner'),
    })
  }
  // ADR-0021: an agent asks its operator for a role; only the operator's approval adds it.
  if (req.tool === 'request_role') {
    if (!Schema.is(Schema.String)(operationKey))
      throw new BoardError('invalid', 'request_role requires a stable operationKey; retry with the same key')
    const request = Schema.decodeUnknownSync(RoleRequestInput)(args, { onExcessProperty: 'error' })
    const result = new AgentRoles(agents).request(agent, req.env.boardId, operationKey, request)
    return await answered({ network: req.env.network, bindings, agent, tool: req.tool, key: operationKey }, result)
  }
  if (req.tool === 'request_backing')
    return toJson({
      ok: true,
      result: await requestBacking({
        reads: chainBackingReads(ctx),
        agent,
        origin: publicOrigin(),
        request: Schema.decodeUnknownSync(BackingRequestInput)(args, { onExcessProperty: 'error' }),
      }),
    })
  if (requiredToolScope(req.tool) === 'sidequest:read') return tenant.call(prepare(req.tool, args))
  if (req.tool === 'advertise_service' || req.tool === 'withdraw_service') {
    if (agent.agent_id === null) throw new BoardError('conflict', 'Register this agent before listing it')
    const audience = directoryAudience(new URL(req.resource).origin)
    const directory = new AgentDirectory({
      agents,
      signing,
      audience,
      boardId: req.env.boardId,
      port: directoryPort(bindings, {
        network: req.env.network,
        rpcUrl: req.env.rpcUrl,
        audience,
        agentId: agent.agent_id,
      }),
    })
    const listing =
      req.tool === 'advertise_service'
        ? await directory.advertise(agent.id, operationKey as string, args.service)
        : await directory.withdraw(
            agent.id,
            operationKey as string,
            args.serviceId === undefined ? {} : { serviceId: String(args.serviceId) },
          )
    return toJson({ ok: true, result: { listing } })
  }
  const executor = new AgentExecutor({
    sql,
    now: () => Math.floor(Date.now() / 1000),
    context: ctx,
    signing,
    sponsor,
    ...(submitter === undefined ? {} : { submitter }),
    verifyAction: (action) =>
      publishAgentOffer({
        sql: fromD1(bindings.Database as never),
        bucket: bindings.Manifests as OfferBucket | undefined,
        boardId: req.env.boardId,
        action,
        now: Math.floor(Date.now() / 1000),
      }),
    prepareTool: async (input) => {
      if (input.tool === 'sweep_earnings') {
        const token = String(input.args.token ?? '')
        if (
          ![...ctx.deployment.rewardTokens, ctx.deployment.factory].some(
            (address) => address.toLowerCase() === token.toLowerCase(),
          )
        )
          throw new BoardError('forbidden', 'Sweep only configured tokens')
        const amount = await ctx.publicClient.readContract({
          address: token as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [agent.address!],
        })
        if (amount === 0n) throw new BoardError('conflict', 'This token balance is empty')
        return {
          token,
          amount: amount.toString(),
          transactions: [
            {
              to: token as Address,
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [agent.operator, amount] }),
              value: '0',
              description: 'Move earnings to your operator wallet',
              chainId: ctx.deployment.chainId,
            },
          ],
        }
      }
      if (input.tool === 'request_permissions') {
        return {
          request: permissions.parse(
            agent,
            input.args.permission as sdk.PermissionRequest,
            input.args.standing === true,
          ),
        }
      }
      if (input.tool === 'use_permission') {
        return permissions.use(agent, permissionHash(input.args.permissionId), permissionUseInput(input.args))
      }
      const reply = JSON.parse(await tenantFor(input.tool).call(prepare(input.tool, input.args))) as BoardReply
      if (!reply.ok) throw failureFromReply(reply)
      const action = reply.result as import('@sidequest/board').AgentPreparedCall
      return action
    },
    verifyToolSigning: async (input) => {
      // SAFETY: verifyAgentSigning answers a BoardReply envelope (board.ts), as call does.
      const reply = JSON.parse(
        await tenant.verifyAgentSigning({ ...prepare(input.tool, input.args), typedData: input.typedData }),
      ) as BoardReply
      if (!reply.ok) throw failureFromReply(reply)
      // SAFETY: a successful signing check answers the string verifyAgentSigning returns.
      return reply.result as string
    },
  })
  try {
    const key = typeof operationKey === 'string' ? operationKey : crypto.randomUUID()
    const result = await executor.execute({
      agentId: agent.id,
      boardId: req.env.boardId,
      tool: req.tool,
      args,
      operationKey: key,
    })
    return await answered({ network: req.env.network, bindings, agent, tool: req.tool, key }, result)
  } catch (error) {
    // A floor refusal sent nothing; alert the owners now instead of waiting for the indexer's next balance check.
    if (
      req.env.network === 'monad-testnet' &&
      (error as { reason?: unknown }).reason === 'floor' &&
      bindings.Database !== undefined
    ) {
      await watchRelay(fromD1(bindings.Database as never), {
        network: req.env.network,
        now: Math.floor(Date.now() / 1000),
        relay: ctx.deployment.relay,
        balance: () => ctx.publicClient.getBalance({ address: ctx.deployment.relay }),
      }).catch(reportRelayWatchFailure)
    }
    throw error
  }
}

function permissionUseInput(args: Record<string, unknown>): { transfer?: { amount?: unknown } } {
  const transfer = Schema.decodeUnknownSync(
    Schema.UndefinedOr(
      Schema.Struct({ amount: Schema.optional(Schema.Unknown), recipient: Schema.optional(Schema.Unknown) }),
    ),
  )(args.transfer)
  return transfer === undefined ? {} : { transfer }
}

function permissionHash(value: unknown): Hex {
  const hash = Schema.decodeUnknownSync(Schema.String)(value)
  if (!isHex(hash) || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new BoardError('invalid', 'Invalid permissionId')
  return hash
}
