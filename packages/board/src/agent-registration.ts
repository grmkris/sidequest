/** Self-paid registration freezes a prediction and consent before the operator sends its atomic batch. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, decodeFunctionResult, parseEventLogs, recoverTypedDataAddress } from 'viem'
import { AgentStore, type AgentRow } from './agents.ts'
import { AgentSigning } from './agent-signing.ts'
import { assertAgentEnvelope } from './agent-signing-scope.ts'
import { prepareAgentSignRequest, finishAgentSignRequest } from './agent-signing-store.ts'
import { hostedAgentURI, type AgentOnboardingDeps } from './agent-onboarding.ts'
import { BoardError } from './board-error.ts'

interface RegistrationPlan {
  predictedAgentId: string
  deadline: number
  agentURI: string
}

export interface RegistrationBatch extends RegistrationPlan {
  calls: readonly { to: Address; data: Hex; value: string }[]
}

/** The extra consent path can sign only a prediction frozen by this registration operation. */
class RegistrationConsentSigning extends AgentSigning {
  override async signConsent(id: string, purpose: string, consent: sdk.AgentWalletConsent): Promise<Hex> {
    const [operationId, step] = purpose.split(':')
    const agent = this.agents.get(id)
    const operation = this.agents.operation(operationId ?? '')
    const plan = this.agents.step<RegistrationPlan>(operation.id, `registration-plan:${step}`)
    if (
      operation.agent_id !== id ||
      operation.tool !== 'agent_registration_batch' ||
      plan === undefined ||
      agent.state !== 'grants-live' ||
      agent.agent_id !== null ||
      agent.address === null ||
      agent.privy_wallet_id === null ||
      agent.chain_id !== this.context.deployment.chainId ||
      agent.registry.toLowerCase() !== this.context.deployment.identity.toLowerCase() ||
      plan.predictedAgentId !== consent.agentId.toString() ||
      plan.deadline !== Number(consent.deadline) ||
      consent.owner.toLowerCase() !== agent.operator.toLowerCase() ||
      consent.newWallet.toLowerCase() !== agent.address.toLowerCase() ||
      consent.deadline <= BigInt(this.now()) ||
      consent.deadline > BigInt(this.now() + 300)
    )
      throw new BoardError('conflict', 'Consent differs from the frozen registration prediction')
    const typedData = sdk.agentWalletTypedData(this.context.deployment, consent)
    assertAgentEnvelope(this.context, typedData, agent.address)
    const request = prepareAgentSignRequest(this.sql, {
      agentId: id,
      purpose: `registration-batch:${purpose}`,
      walletId: agent.privy_wallet_id,
      request: { method: 'eth_signTypedData_v4', typedData },
      now: this.now(),
    })
    if (request.result_json !== null) {
      // SAFETY: this row stores only the verified hex signature produced below.
      return JSON.parse(request.result_json) as Hex
    }
    const signature = await this.provider.signTypedData(agent.privy_wallet_id, typedData, request.id)
    // SAFETY: sdk.agentWalletTypedData builds this exact viem EIP-712 envelope.
    const typed = JSON.parse(typedData) as Parameters<typeof recoverTypedDataAddress>[0]
    if ((await recoverTypedDataAddress({ ...typed, signature })).toLowerCase() !== agent.address.toLowerCase())
      throw new BoardError('forbidden', 'Registration consent does not recover to the bound agent wallet')
    finishAgentSignRequest(this.sql, request, signature)
    return signature
  }
}

export class AgentRegistration {
  readonly agents: AgentStore
  constructor(
    readonly deps: Pick<AgentOnboardingDeps, 'sql' | 'context' | 'now' | 'publicOrigin'> & { signing?: AgentSigning },
  ) {
    this.agents = new AgentStore(deps.sql, deps.now)
  }

  async prepare(id: string, operator: Address, operationKey: string): Promise<RegistrationBatch> {
    const agent = this.agents.owned(id, operator)
    if (agent.state !== 'grants-live' || agent.agent_id !== null || agent.address === null)
      throw new BoardError('conflict', 'Prepare the agent wallet and its own routine grants before registration')
    if (await this.#recordLanded(id, operator, agent.address))
      throw new BoardError('conflict', 'This agent was already registered by an earlier batch; reload to continue')
    const operation = this.agents.begin(id, operationKey, 'public', 'agent_registration_batch', {})
    const { attempt, saved } = this.#latest(operation.id)
    const plan = saved ?? (await this.#predict(id, operator, operation.id, attempt))
    const priorBatch = this.agents.step<RegistrationBatch>(operation.id, `registration-batch:${attempt}`)
    if (priorBatch !== undefined) return priorBatch
    const consent = {
      agentId: BigInt(plan.predictedAgentId),
      deadline: BigInt(plan.deadline),
      owner: operator,
      newWallet: agent.address,
    }
    if (this.deps.signing === undefined)
      throw new BoardError('unavailable', 'Registration consent signing is unavailable')
    const signing = new RegistrationConsentSigning(
      this.deps.sql,
      this.deps.context,
      this.deps.signing.provider,
      this.deps.now,
    )
    const signature = await signing.signConsent(id, `${operation.id}:${attempt}`, consent)
    return this.agents.freezeStep(operation.id, `registration-batch:${attempt}`, {
      ...plan,
      calls: [
        { to: agent.registry, data: sdk.registerCalldata(plan.agentURI), value: '0' },
        { to: agent.registry, data: sdk.setAgentWalletCalldata(consent, signature), value: '0' },
      ],
    })
  }

  /**
   * A batch that landed but was never recorded (its page lost the receipt) is bound from chain state instead of being
   * prepared again: past its consent deadline a fresh batch would mint this agent a second ID. Only this agent's wallet
   * can sign the binding consent, so the predicted ID's owner, wallet and profile URI together prove the batch was ours.
   */
  async #recordLanded(id: string, operator: Address, wallet: Address): Promise<boolean> {
    const agent = this.agents.get(id)
    const batches = this.deps.sql.all<{ operation_id: Hex; name: string; value_json: string }>(
      `SELECT s.operation_id,s.name,s.value_json FROM agent_operation_steps s JOIN agent_operations o ON o.id=s.operation_id
       WHERE o.agent_id=? AND o.tool='agent_registration_batch' AND s.name LIKE 'registration-batch:%'`,
      id,
    )
    const client = this.deps.context.publicClient
    for (const row of batches) {
      // SAFETY: these steps are exclusively the batches prepared below.
      const batch = JSON.parse(row.value_json) as RegistrationBatch
      const agentId = BigInt(batch.predictedAgentId)
      const [owner, uri, bound] = await Promise.all([
        client
          .readContract({ address: agent.registry, abi: sdk.identityAbi, functionName: 'ownerOf', args: [agentId] })
          .catch(() => undefined),
        client
          .readContract({ address: agent.registry, abi: sdk.identityAbi, functionName: 'tokenURI', args: [agentId] })
          .catch(() => undefined),
        sdk.agentWallet(this.deps.context, agentId).catch(() => undefined),
      ])
      if (
        owner?.toLowerCase() !== operator.toLowerCase() ||
        uri !== batch.agentURI ||
        bound?.toLowerCase() !== wallet.toLowerCase()
      )
        continue
      this.agents.freezeStep(row.operation_id, `registration-recovered:${row.name.split(':')[1]}`, agentId.toString())
      this.agents.bindRegistry(id, agentId.toString())
      this.agents.advance(id, 'registered')
      this.agents.advance(id, 'active')
      return true
    }
    return false
  }

  #latest(operationId: Hex): { attempt: number; saved?: RegistrationPlan } {
    const prior = this.deps.sql
      .all<{ name: string; value_json: string }>(
        "SELECT name,value_json FROM agent_operation_steps WHERE operation_id=? AND name LIKE 'registration-plan:%'",
        operationId,
      )
      .toSorted((a, b) => Number(b.name.split(':')[1]) - Number(a.name.split(':')[1]))[0]
    if (prior === undefined) return { attempt: 1 }
    // SAFETY: only #predict writes these registration plan steps.
    const saved = JSON.parse(prior.value_json) as RegistrationPlan
    const attempt = Number(prior.name.split(':')[1])
    return saved.deadline > this.deps.now() ? { attempt, saved } : { attempt: attempt + 1 }
  }

  async #predict(id: string, operator: Address, operationId: Hex, attempt: number): Promise<RegistrationPlan> {
    const agentURI = hostedAgentURI(this.deps.publicOrigin, id)
    const result = await this.deps.context.publicClient.call({
      account: operator,
      to: this.agents.get(id).registry,
      data: sdk.registerCalldata(agentURI),
    })
    if (result.data === undefined) throw new BoardError('unavailable', 'The registry did not return a predicted ID')
    const predicted = decodeFunctionResult({ abi: sdk.identityAbi, functionName: 'register', data: result.data })
    if (predicted <= 0n) throw new BoardError('unavailable', 'The registry returned an invalid predicted ID')
    return this.agents.freezeStep(operationId, `registration-plan:${attempt}`, {
      predictedAgentId: predicted.toString(),
      deadline: this.deps.now() + 300,
      agentURI,
    })
  }

  async record(id: string, operator: Address, txHash: Hex): Promise<AgentRow> {
    const agent = this.agents.owned(id, operator)
    if (!['grants-live', 'registered', 'active'].includes(agent.state))
      throw new BoardError('conflict', 'Agent is not ready for registration')
    const receipt = await this.deps.context.publicClient.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success')
      throw new BoardError(
        'conflict',
        'Registration batch reverted; the predicted ID may have raced. Prepare a fresh batch.',
      )
    const minted = parseEventLogs({ abi: sdk.identityAbi, logs: receipt.logs, eventName: 'Registered' }).filter(
      (log) => log.address.toLowerCase() === agent.registry.toLowerCase(),
    )
    const mint = minted[0]
    if (minted.length !== 1 || mint === undefined || mint.args.owner.toLowerCase() !== operator.toLowerCase())
      throw new BoardError('conflict', 'Registration receipt must contain exactly one mint to this operator')
    const batches = this.deps.sql.all<{ operation_id: Hex; name: string; value_json: string }>(
      `SELECT s.operation_id,s.name,s.value_json FROM agent_operation_steps s JOIN agent_operations o ON o.id=s.operation_id
       WHERE o.agent_id=? AND o.tool='agent_registration_batch' AND s.name LIKE 'registration-batch:%'`,
      id,
    )
    const matched = batches.find((row) => {
      // SAFETY: these steps are exclusively the batches prepared above.
      const batch = JSON.parse(row.value_json) as RegistrationBatch
      return batch.predictedAgentId === mint.args.agentId.toString() && batch.agentURI === mint.args.agentURI
    })
    if (matched === undefined)
      throw new BoardError('conflict', 'The minted ID or profile URI differs from the prepared batch')
    const wallet = await this.deps.context.publicClient.readContract({
      address: agent.registry,
      abi: sdk.identityAbi,
      functionName: 'getAgentWallet',
      args: [mint.args.agentId],
      blockNumber: receipt.blockNumber,
    })
    if (agent.address === null || wallet.toLowerCase() !== agent.address.toLowerCase())
      throw new BoardError('conflict', 'The registration receipt did not bind this agent wallet')
    const [owner, currentWallet] = await Promise.all([
      this.deps.context.publicClient.readContract({
        address: agent.registry,
        abi: sdk.identityAbi,
        functionName: 'ownerOf',
        args: [mint.args.agentId],
      }),
      sdk.agentWallet(this.deps.context, mint.args.agentId),
    ])
    if (owner.toLowerCase() !== operator.toLowerCase() || currentWallet.toLowerCase() !== agent.address.toLowerCase())
      throw new BoardError('conflict', 'Current registry owner or agent wallet differs from this binding')
    this.agents.freezeStep(matched.operation_id, `registration-receipt:${matched.name.split(':')[1]}`, txHash)
    this.agents.bindRegistry(id, mint.args.agentId.toString())
    if (agent.state === 'grants-live') this.agents.advance(id, 'registered')
    return this.agents.advance(id, 'active')
  }
}
