/** Server-created wallets and resumable registry ownership. Each provider/send identity is persisted first. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, type SignedAuthorization, parseEventLogs, keccak256, stringToHex } from 'viem'
import { AgentStore, type AgentRow } from './agents.ts'
import { AgentSigning } from './agent-signing.ts'
import { ensureAgentGrants } from './agent-grant-renewal.ts'
import { GrantStore } from './grants.ts'
import { RelaySender } from './relay.ts'
import { SponsorDesk } from './sponsor.ts'
import type { Sql } from './store.ts'
import { BoardError } from './board-error.ts'
import { AgentRegistration } from './agent-registration.ts'
import type { UserOpSubmitter } from './userop-desk.ts'
export { AgentRegistration } from './agent-registration.ts'

export interface AgentWalletCreator {
  createAgentWallet(input: {
    userId: string
    signerId: string
    policyId: string
    operationKey: string
  }): Promise<sdk.PrivyAgentWallet>
  verifyAgentWallet(walletId: string, userId: string, signerId: string, policyId: string): Promise<sdk.PrivyAgentWallet>
}

export interface AgentOnboardingDeps {
  readonly sql: Sql
  readonly context: sdk.Ctx
  readonly now: () => number
  readonly signing: AgentSigning
  readonly relay?: RelaySender
  readonly submitter?: UserOpSubmitter
  readonly sponsor: SponsorDesk
  readonly signerId: string
  readonly policyId: string
  readonly publicOrigin?: string
}

export function hostedAgentURI(origin: string | undefined, agentKey: string): string {
  let url: URL
  try {
    url = new URL(origin ?? '')
  } catch {
    throw new BoardError('unavailable', 'Hosted agent registration requires the public origin')
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username !== '' ||
    url.password !== '' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(agentKey)
  )
    throw new BoardError('invalid', 'Invalid hosted profile URI')
  return `${url.origin}/profiles/${agentKey}.json`
}

function salt(id: string, purpose: string): bigint {
  return BigInt(keccak256(stringToHex(JSON.stringify([id, purpose]))))
}

export class AgentOnboarding {
  readonly agents: AgentStore
  readonly grants: GrantStore

  constructor(readonly deps: AgentOnboardingDeps) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.grants = new GrantStore(deps.sql, deps.context)
  }

  async create(
    input: { id: string; operator: Address; userId: string; name: string },
    wallets: AgentWalletCreator,
  ): Promise<AgentRow> {
    const ctx = this.deps.context
    let agent = this.agents.create({
      id: input.id,
      operator: input.operator,
      privyUserId: input.userId,
      name: input.name,
      registry: ctx.deployment.identity,
      chainId: ctx.deployment.chainId,
    })
    if (agent.state === 'revoked') throw new Error('Revoked agents cannot be onboarded again')
    this.agents.begin(agent.id, 'onboarding', 'public', 'agent_onboarding', {})
    if (agent.privy_wallet_id === null) {
      const key = keccak256(stringToHex(JSON.stringify(['agent-wallet', agent.id])))
      const wallet = await wallets.createAgentWallet({
        userId: agent.privy_user_id,
        signerId: this.deps.signerId,
        policyId: this.deps.policyId,
        operationKey: key,
      })
      if (wallet.address.toLowerCase() === agent.operator.toLowerCase())
        throw new Error('The agent must have its own wallet')
      agent = this.agents.bindWallet(agent.id, wallet.id, wallet.address)
    } else {
      const wallet = await wallets.verifyAgentWallet(
        agent.privy_wallet_id,
        agent.privy_user_id,
        this.deps.signerId,
        this.deps.policyId,
      )
      if (wallet.address.toLowerCase() !== agent.address?.toLowerCase())
        throw new Error('Provider wallet differs from the persisted binding')
    }
    return this.resume(agent.id)
  }

  async resume(id: string): Promise<AgentRow> {
    const { context: ctx, signing } = this.deps
    let agent = this.agents.get(id)
    if (agent.state === 'revoked' || agent.address === null || agent.privy_wallet_id === null)
      throw new Error('Agent is unavailable for onboarding')
    const operation = this.agents.begin(id, 'onboarding', 'public', 'agent_onboarding', {})
    if (this.deps.submitter !== undefined && (agent.state === 'created' || agent.state === 'upgraded'))
      return this.agents.advance(id, 'grants-live')
    if (agent.state === 'created') agent = await this.#upgrade(id, agent.address, operation.id)
    if (agent.state === 'upgraded') {
      await ensureAgentGrants(ctx, this.agents, this.grants, signing, id, operation.id, this.deps.now())
      agent = this.agents.advance(id, 'grants-live')
    }
    return agent
  }

  async #upgrade(id: string, address: Address, operationId: Hex): Promise<AgentRow> {
    const { context: ctx, signing } = this.deps
    const operation = { id: operationId }
    const prior = this.agents.step<SignedAuthorization>(operation.id, 'authorization')
    if (
      prior !== undefined ||
      (await sdk.delegationOf(ctx.publicClient, address))?.toLowerCase() !==
        ctx.deployment.delegation.delegator.toLowerCase()
    ) {
      let nonce = this.agents.step<number>(operation.id, 'upgrade-nonce')
      if (nonce === undefined)
        nonce = this.agents.freezeStep(
          operation.id,
          'upgrade-nonce',
          await ctx.publicClient.getTransactionCount({ address: address, blockTag: 'pending' }),
        )
      const authorization =
        prior ?? this.agents.freezeStep(operation.id, 'authorization', await signing.signUpgrade(id, nonce))
      const receipt = await this.#relay().submit({
        key: `agent-upgrade-${id}`,
        to: address,
        data: '0x',
        authorizationList: [authorization],
      })
      this.agents.freezeStep(operation.id, 'upgrade-receipt', receipt.transactionHash)
    }
    if (
      (await sdk.delegationOf(ctx.publicClient, address))?.toLowerCase() !==
      ctx.deployment.delegation.delegator.toLowerCase()
    )
      throw new Error('Agent upgrade is not confirmed')
    return this.agents.advance(id, 'upgraded')
  }

  #relay(): RelaySender {
    if (this.deps.relay === undefined) throw new BoardError('unavailable', 'The hosted-agent relay is unavailable')
    return this.deps.relay
  }

  #requireOperatorRegistration(): void {
    if (this.deps.submitter !== undefined)
      throw new BoardError('conflict', 'Use registration-batch and registration-record for operator-paid registration')
  }

  async prepareRegistration(id: string, operator: Address) {
    this.#requireOperatorRegistration()
    let agent = this.agents.owned(id, operator)
    if (agent.state !== 'grants-live' && agent.state !== 'registered')
      throw new Error('Prepare the agent upgrade and gas grants first')
    await this.deps.sponsor.ready()
    const operation = this.agents.begin(id, 'onboarding', 'public', 'agent_onboarding', {})
    const onboarding = JSON.parse(agent.onboarding_json) as { registrationHash?: Hex; registrationAttempt?: number }
    const prior = onboarding.registrationHash
    if (prior !== undefined) {
      const row = this.grants.get(prior)!
      // Reconcile both original sends before replacing any authority or consent.
      for (const purpose of ['register', 'set-wallet']) {
        const key = `agent-${purpose}-${id}-${prior.slice(2, 14)}`
        const stored = this.deps.sql.all(
          'SELECT id FROM sponsor_operations WHERE wallet=? AND action_key=?',
          operator.toLowerCase(),
          key,
        )[0]
        if (stored === undefined) continue
        const result = await this.deps.sponsor.submit(operator, [], key)
        if (result.status === 'pending')
          throw new Error('Registration is pending; reconcile before replacing its grant')
        if (purpose === 'register' && result.status === 'confirmed' && agent.agent_id === null)
          agent = await this.#recordMint(id, result.txHash)
      }
      if (await this.#finishBinding(id)) return this.grants.prepare(operator, this.grants.spec(prior))
      const consent = this.agents.step<{ deadline: string }>(operation.id, `consent:${prior}`)
      if (row.expires_at > this.deps.now() && (consent === undefined || Number(consent.deadline) > this.deps.now()))
        return this.grants.prepare(operator, this.grants.spec(prior))
    }
    const attempt = (onboarding.registrationAttempt ?? 0) + 1
    const prepared = this.grants.prepare(operator, {
      kind: 'registration',
      delegator: operator,
      salt: salt(id, `registration:${attempt}`),
      start: this.deps.now(),
    })
    this.agents.freezeStep(operation.id, `registration:${attempt}`, { hash: prepared.hash })
    this.agents.updateOnboarding(id, { ...onboarding, registrationHash: prepared.hash, registrationAttempt: attempt })
    return prepared
  }

  async #recordMint(id: string, hash: Hex): Promise<AgentRow> {
    const agent = this.agents.get(id)
    const receipt = await this.deps.context.publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('Registration receipt reverted')
    const minted = parseEventLogs({ abi: sdk.identityAbi, logs: receipt.logs, eventName: 'Registered' }).filter(
      (log) =>
        log.address.toLowerCase() === agent.registry.toLowerCase() &&
        log.args.owner.toLowerCase() === agent.operator.toLowerCase(),
    )
    if (minted.length !== 1) throw new Error('Registration receipt does not contain one mint to this operator')
    this.agents.bindRegistry(id, minted[0]!.args.agentId.toString())
    return this.agents.advance(id, 'registered')
  }

  registrationBatch(id: string, operator: Address, operationKey: string) {
    return new AgentRegistration(this.deps).prepare(id, operator, operationKey)
  }

  registrationRecord(id: string, operator: Address, txHash: Hex): Promise<AgentRow> {
    return new AgentRegistration(this.deps).record(id, operator, txHash)
  }

  async register(
    id: string,
    operator: Address,
    hash: Hex,
    signature: Hex,
  ): Promise<AgentRow | { status: string; txHash: Hex }> {
    this.#requireOperatorRegistration()
    let agent = this.agents.owned(id, operator)
    if (agent.state === 'active') return this.verify(id)
    if (await this.#finishBinding(id)) return this.agents.get(id)
    if (agent.state !== 'grants-live' && agent.state !== 'registered')
      throw new Error('Agent is not ready for registration')
    const { context: ctx, sponsor, signing } = this.deps
    const operation = this.agents.begin(id, 'onboarding', 'public', 'agent_onboarding', {})
    const saved = JSON.parse(agent.onboarding_json) as { registrationHash?: Hex }
    if (saved.registrationHash !== hash) throw new Error('Registration differs from the persisted operator request')
    const spec = this.grants.spec(hash)
    if (spec.kind !== 'registration' || spec.delegator.toLowerCase() !== operator.toLowerCase())
      throw new Error('Not this operator registration grant')
    await this.grants.confirm(hash, signature)
    if (agent.agent_id === null) {
      const prior = this.agents.step<Hex>(operation.id, 'register-data')
      const data =
        prior ??
        this.agents.freezeStep(
          operation.id,
          'register-data',
          sdk.registerCalldata(hostedAgentURI(this.deps.publicOrigin, agent.id)),
        )
      const result = await sponsor.submit(
        operator,
        [{ grant: hash, calls: [{ to: ctx.deployment.identity, data }] }],
        `agent-register-${id}-${hash.slice(2, 14)}`,
      )
      if (result.status !== 'confirmed') return { status: result.status, txHash: result.txHash }
      agent = await this.#recordMint(id, result.txHash)
    }
    let consent = this.agents.step<{ deadline: string }>(operation.id, `consent:${hash}`)
    if (consent === undefined)
      consent = this.agents.freezeStep(operation.id, `consent:${hash}`, {
        deadline: String(Math.min(this.deps.now() + 300, this.grants.get(hash)!.expires_at)),
      })
    if (Number(consent.deadline) <= this.deps.now())
      throw new Error('Registration consent expired; prepare a replacement registration grant')
    const message = {
      agentId: BigInt(agent.agent_id!),
      owner: operator,
      newWallet: agent.address!,
      deadline: BigInt(consent.deadline),
    }
    let data = this.agents.step<Hex>(operation.id, `set-wallet-data:${hash}`)
    if (data === undefined) {
      const consentSignature = await signing.signConsent(id, `onboarding:${hash}`, message)
      data = this.agents.freezeStep(
        operation.id,
        `set-wallet-data:${hash}`,
        sdk.setAgentWalletCalldata(message, consentSignature),
      )
    }
    const result = await sponsor.submit(
      operator,
      [{ grant: hash, calls: [{ to: ctx.deployment.identity, data }] }],
      `agent-set-wallet-${id}-${hash.slice(2, 14)}`,
    )
    if (result.status !== 'confirmed') return { status: result.status, txHash: result.txHash }
    await this.verify(id)
    this.agents.advance(id, 'active')
    return this.agents.get(id)
  }

  async #finishBinding(id: string): Promise<boolean> {
    const agent = this.agents.get(id)
    if (agent.state !== 'registered' || agent.agent_id === null || agent.address === null) return false
    const wallet = await sdk.agentWallet(this.deps.context, BigInt(agent.agent_id))
    if (wallet.toLowerCase() !== agent.address.toLowerCase()) return false
    await this.verify(id)
    this.agents.advance(id, 'active')
    return true
  }

  async verify(id: string): Promise<AgentRow> {
    const agent = this.agents.get(id)
    if (agent.agent_id === null || agent.address === null) throw new Error('Agent registry binding is incomplete')
    const [owner, wallet] = await Promise.all([
      this.deps.context.publicClient.readContract({
        address: agent.registry,
        abi: sdk.identityAbi,
        functionName: 'ownerOf',
        args: [BigInt(agent.agent_id)],
      }),
      sdk.agentWallet(this.deps.context, BigInt(agent.agent_id)),
    ])
    if (owner.toLowerCase() !== agent.operator.toLowerCase() || wallet.toLowerCase() !== agent.address.toLowerCase())
      throw new Error('Current registry owner or agent wallet differs from this binding')
    return agent
  }
}
