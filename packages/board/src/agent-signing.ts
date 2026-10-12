/** Persist each provider request before signing and recover its exact result after restarts. */
import * as sdk from '@sidequest/sdk'
import { type Hex, type SignedAuthorization, isAddressEqual, recoverTypedDataAddress } from 'viem'
import { recoverAuthorizationAddress } from 'viem/utils'
import { AgentStore } from './agents.ts'
import { type DirectoryBinding, assertAgentEnvelope, assertExactAgentTypedData } from './agent-signing-scope.ts'
import { GrantStore } from './grants.ts'
import type { Sql } from './store.ts'
import { prepareAgentSignRequest, finishAgentSignRequest, type AgentSignRequest } from './agent-signing-store.ts'
import { x402TypedData, type X402Authorization } from './x402.ts'

export interface RoutineSigner {
  signTypedData(walletId: string, typedData: string, operationKey: string): Promise<Hex>
  signAuthorization(
    walletId: string,
    contract: `0x${string}`,
    chainId: number,
    nonce: number,
    operationKey: string,
  ): Promise<SignedAuthorization<number>>
  /** Absent where no provider signs user operations; `signUserOperation` then refuses. */
  signUserOperation?(
    walletId: string,
    contract: `0x${string}`,
    chainId: number,
    op: sdk.UserOperation,
    operationKey: string,
  ): Promise<Hex>
}

export class AgentSigning {
  readonly agents: AgentStore
  readonly grants: GrantStore

  constructor(
    readonly sql: Sql,
    readonly context: sdk.Ctx,
    readonly provider: RoutineSigner,
    readonly now: () => number,
  ) {
    this.agents = new AgentStore(sql, now)
    this.grants = new GrantStore(sql, context)
  }

  #agent(id: string) {
    const agent = this.agents.get(id)
    if (
      agent.state === 'revoked' ||
      agent.address === null ||
      agent.privy_wallet_id === null ||
      agent.chain_id !== this.context.deployment.chainId ||
      agent.registry.toLowerCase() !== this.context.deployment.identity.toLowerCase()
    )
      throw new Error('Agent is unavailable for routine signing')
    return { ...agent, address: agent.address, privy_wallet_id: agent.privy_wallet_id }
  }

  #request(id: string, purpose: string, request: unknown): AgentSignRequest {
    const agent = this.#agent(id)
    return prepareAgentSignRequest(this.sql, {
      agentId: id,
      purpose,
      walletId: agent.privy_wallet_id,
      request,
      now: this.now(),
    })
  }

  #save(row: AgentSignRequest, result: unknown): void {
    finishAgentSignRequest(this.sql, row, result)
  }

  async #typed(
    id: string,
    purpose: string,
    typedData: string,
    verify: () => Promise<string>,
    directory?: DirectoryBinding,
  ): Promise<Hex> {
    const agent = this.#agent(id)
    assertAgentEnvelope(this.context, typedData, agent.address, directory)
    const row = this.#request(id, purpose, { method: 'eth_signTypedData_v4', typedData })
    if (row.result_json !== null) return JSON.parse(row.result_json) as Hex
    assertExactAgentTypedData(typedData, await verify())
    this.#agent(id)
    const signature = await this.provider.signTypedData(agent.privy_wallet_id, typedData, row.id)
    const typed = JSON.parse(typedData) as Parameters<typeof recoverTypedDataAddress>[0]
    const recovered = await recoverTypedDataAddress({ ...typed, signature })
    if (recovered.toLowerCase() !== agent.address.toLowerCase())
      throw new Error('Routine signature does not recover to the bound agent')
    this.#save(row, signature)
    return signature
  }

  /** The board reconstructs current job, listing, selection and net quote before every tool signature. */
  signTool(id: string, operationId: Hex, typedData: string, verify: () => Promise<string>): Promise<Hex> {
    const type = assertAgentEnvelope(this.context, typedData, this.#agent(id).address).primaryType
    if (!['Selection', 'SetBudgetAuthorization', 'SubmitAuthorization'].includes(type))
      throw new Error('Not a routine tool signature')
    return this.#typed(id, `tool:${operationId}`, typedData, verify)
  }

  /** Freeze one EIP-3009 authorization per payment operation before asking the provider. */
  async signX402(id: string, operationId: Hex, typedData: string): Promise<Hex> {
    const agent = this.#agent(id)
    const operation = this.agents.operation(operationId)
    if (operation.agent_id !== id || operation.tool !== 'x402_pay' || agent.state !== 'active')
      throw new Error('Not this agent payment operation')
    const authorized = this.agents.step<X402Authorization>(operationId, 'x402-authorization')
    if (authorized === undefined) throw new Error('Missing frozen x402 authorization')
    assertExactAgentTypedData(typedData, x402TypedData(this.context.deployment, authorized))
    const frozen = this.agents.freezeStep(operationId, 'x402-typed-data', typedData)
    const row = this.#request(id, `x402:${operationId}`, { method: 'eth_signTypedData_v4', typedData: frozen })
    if (row.result_json !== null) return JSON.parse(row.result_json) as Hex
    if (
      assertAgentEnvelope(this.context, frozen, agent.address, undefined, this.now()).primaryType !==
      'TransferWithAuthorization'
    )
      throw new Error('Not an x402 authorization')
    const payment = this.sql.all<{ nonce: string; asset: string; pay_to: string; value: string; valid_before: number }>(
      'SELECT * FROM x402_payments WHERE operation_id=? AND agent_id=?',
      operationId,
      id,
    )[0]
    if (
      payment?.nonce !== authorized.nonce ||
      payment.asset.toLowerCase() !== this.context.deployment.x402!.usdc.toLowerCase() ||
      payment.pay_to !== authorized.to ||
      payment.value !== authorized.value ||
      payment.valid_before !== Number(authorized.validBefore)
    )
      throw new Error('x402 authorization has no matching ledger reservation')
    this.#agent(id)
    const signature = await this.provider.signTypedData(agent.privy_wallet_id, frozen, row.id)
    const typed = JSON.parse(frozen) as Parameters<typeof recoverTypedDataAddress>[0]
    if ((await recoverTypedDataAddress({ ...typed, signature })).toLowerCase() !== agent.address.toLowerCase())
      throw new Error('Routine signature does not recover to the bound agent')
    if (this.sql.atomic === undefined) throw new Error('x402 signing requires atomic storage')
    this.sql.atomic(() => {
      this.#save(row, signature)
      this.sql.run('UPDATE x402_payments SET created_at=? WHERE operation_id=?', this.now(), operationId)
    })
    return signature
  }

  /**
   * A record of the agent's own directory listing (an enrollment, a service ad or its take-down) for the directory at
   * `audience`. `verify` returns the record the directory prepared, rebuilt from its state; the signature is journaled
   * per record, so a retry of the same record gets the same signature.
   */
  signDirectory(
    id: string,
    record: sdk.DirectoryEnvelope,
    audience: string,
    verify: () => Promise<sdk.DirectoryEnvelope>,
  ): Promise<Hex> {
    const agent = this.#agent(id)
    if (agent.agent_id === null) throw new Error('Only a registered agent can sign directory records')
    return this.#typed(
      id,
      `directory:${sdk.directoryRecordHash(record)}`,
      sdk.directoryTypedDataJson(record),
      async () => sdk.directoryTypedDataJson(await verify()),
      { agentId: agent.agent_id, audience },
    )
  }

  signGrant(id: string, hash: Hex): Promise<Hex> {
    const agent = this.#agent(id)
    const row = this.grants.get(hash)
    if (
      row === undefined ||
      row.owner.toLowerCase() !== agent.operator.toLowerCase() ||
      row.delegator.toLowerCase() !== agent.address.toLowerCase() ||
      !['prepared', 'live'].includes(row.status)
    )
      throw new Error('Grant does not belong to this agent')
    const spec = this.grants.spec(hash)
    if (!['agent-work', 'agent-approve', 'agent-approve-once', 'agent-sweep', 'unstake'].includes(spec.kind))
      throw new Error('Grant kind is outside routine authority')
    const typedData = sdk.delegationTypedData(this.context.deployment, sdk.parseDelegation(row.delegation_json))
    return this.#typed(id, `grant:${hash}`, typedData, async () => {
      if (row.expires_at <= this.now() || spec.start > this.now())
        throw new Error('Grant is outside its signing window')
      if (spec.kind === 'agent-sweep' && spec.operator.toLowerCase() !== agent.operator.toLowerCase())
        throw new Error('Sweep must name this operator')
      if (spec.kind === 'agent-approve-once') this.grants.approvedHire(agent.operator, spec)
      if (spec.kind === 'unstake') this.grants.approvedUnstake(agent.operator, spec)
      return sdk.delegationTypedData(this.context.deployment, sdk.buildGrant(this.context, spec))
    })
  }

  signConsent(id: string, purpose: string, consent: sdk.AgentWalletConsent): Promise<Hex> {
    const agent = this.#agent(id)
    const typedData = sdk.agentWalletTypedData(this.context.deployment, consent)
    return this.#typed(id, `consent:${purpose}`, typedData, async () => {
      if (
        agent.agent_id !== consent.agentId.toString() ||
        consent.owner.toLowerCase() !== agent.operator.toLowerCase() ||
        consent.newWallet.toLowerCase() !== agent.address.toLowerCase() ||
        consent.deadline <= BigInt(this.now()) ||
        consent.deadline > BigInt(this.now() + 300)
      )
        throw new Error('Consent differs from the registered agent and owner')
      const owner = await this.context.publicClient.readContract({
        address: agent.registry,
        abi: sdk.identityAbi,
        functionName: 'ownerOf',
        args: [consent.agentId],
      })
      if (owner.toLowerCase() !== agent.operator.toLowerCase())
        throw new Error('Registry owner differs from the operator')
      return sdk.agentWalletTypedData(this.context.deployment, consent)
    })
  }

  /**
   * The agent's signature over one user operation (ADR-0023). The operation must be the agent's own, on the nonce lane
   * of `operationId`, paid through the configured paymaster and carrying no native value; `check` is the board's scope
   * check of every inner call. Journaled per digest, so a retry of the same operation gets the same signature, while a
   * repriced attempt shares the nonce and at most one attempt can land.
   */
  async signUserOperation(
    id: string,
    operationId: string,
    op: sdk.UserOperation,
    check: (calls: readonly sdk.Call[]) => void | Promise<void>,
  ): Promise<Hex> {
    const agent = this.#agent(id)
    const { chainId, aa, delegation } = this.context.deployment
    if (aa === null || aa.paymaster === null || this.provider.signUserOperation === undefined)
      throw new Error('User operations are unavailable on this deployment')
    if (!isAddressEqual(op.sender, agent.address)) throw new Error('User operation is not this agent account')
    if (op.nonce !== sdk.laneNonce(sdk.nonceKey(operationId)))
      throw new Error('User operation is off its operation nonce lane')
    if (op.paymaster === undefined || !isAddressEqual(op.paymaster, aa.paymaster))
      throw new Error('User operation must pay through the configured paymaster')
    const calls = sdk.decodeExecuteCalldata(op.callData)
    if (calls === null || calls.length === 0 || calls.some((call) => call.value !== 0n))
      throw new Error('User operation calls are outside routine authority')
    await check(calls)
    const typed = sdk.delegatorTypedData(op, chainId, aa.entryPoint)
    const digest = sdk.delegatorDigest(op, chainId, aa.entryPoint)
    const row = this.#request(id, `userop:${digest}`, { method: 'eth_signUserOperation', operationId, digest })
    if (row.result_json !== null) {
      // SAFETY: this row stores only the recovered signature saved below.
      return JSON.parse(row.result_json) as Hex
    }
    this.#agent(id)
    const signature = await this.provider.signUserOperation(
      agent.privy_wallet_id,
      delegation.delegator,
      chainId,
      op,
      row.id,
    )
    if (!isAddressEqual(await recoverTypedDataAddress({ ...typed, signature }), agent.address))
      throw new Error('Routine signature does not recover to the bound agent')
    this.#save(row, signature)
    return signature
  }

  async signUpgrade(id: string, nonce: number): Promise<SignedAuthorization<number>> {
    const agent = this.#agent(id)
    if (agent.state !== 'created' && (await sdk.delegationOf(this.context.publicClient, agent.address)) !== null)
      throw new Error('Only an undelegated agent can be upgraded')
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid upgrade nonce')
    const contract = this.context.deployment.delegation.delegator
    const chainId = this.context.deployment.chainId
    const purpose = agent.state === 'created' ? 'upgrade' : `upgrade:${nonce}`
    const row = this.#request(id, purpose, { method: 'eth_sign7702Authorization', contract, chainId, nonce })
    if (row.result_json !== null) return JSON.parse(row.result_json) as SignedAuthorization<number>
    const current = await this.context.publicClient.getTransactionCount({ address: agent.address, blockTag: 'pending' })
    if (current !== nonce) throw new Error('Upgrade nonce differs from the agent account')
    this.#agent(id)
    const authorization = await this.provider.signAuthorization(agent.privy_wallet_id, contract, chainId, nonce, row.id)
    if (
      authorization.address.toLowerCase() !== contract.toLowerCase() ||
      authorization.chainId !== chainId ||
      authorization.nonce !== nonce ||
      (await recoverAuthorizationAddress({ authorization })).toLowerCase() !== agent.address.toLowerCase()
    )
      throw new Error('Upgrade signature is outside the authorized account and chain')
    const result = {
      address: authorization.address,
      chainId: authorization.chainId,
      nonce: authorization.nonce,
      r: authorization.r,
      s: authorization.s,
      yParity: authorization.yParity ?? Number(authorization.v! - 27n),
    }
    this.#save(row, result)
    return result
  }
}
