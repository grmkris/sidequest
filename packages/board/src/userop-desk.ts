/** Journal first, then build/sign/send. Every retry reconciles all hashes and the operation's nonce lane. */
import * as sdk from '@sidequest/sdk'
import { hexField, quantity } from '@sidequest/sdk'
import { type Address, type Hex } from 'viem'
import { AgentFailure } from './agent-failure.ts'
import type { AgentSigning } from './agent-signing.ts'
import { requireGasBudget, withGasFloat, type AgentBatchScope } from './agent-batch.ts'
import { checkAgentBatch } from './agent-calls.ts'
import { hostedBatchGasFloor } from './agent-gas.ts'
import { canonicalAgentArgs } from './agents.ts'
import { UserOpStore, type UserOpRow, thawUserOp } from './userop-store.ts'

export interface UserOpRpc {
  readonly node: sdk.JsonRpc
  readonly bundler: sdk.JsonRpc
  readonly paymaster: sdk.JsonRpc
}
export interface UserOpResult {
  readonly operationId: string
  readonly status: 'pending' | 'confirmed' | 'reverted' | 'dropped'
  readonly userOpHash: Hex | null
  readonly txHash: Hex | null
  readonly actualGasCost: string | null
}
export interface UserOpInput {
  readonly id: Hex
  readonly agentId: string
  readonly calls: readonly sdk.Call[]
  readonly evidenceCall?: sdk.Call
}
export interface UserOpSubmitter {
  ready(agentId: string): Promise<void>
  submit(operation: UserOpInput): Promise<UserOpResult>
  /** Readback reconciles, but never sends or rebuilds an operation. */
  operation(id: string): Promise<UserOpResult | undefined>
}

const queues = new Map<string, Promise<void>>()
const freezeCall = (call: sdk.Call) => ({ ...call, value: call.value.toString() })
const terminal = (row: UserOpRow) => row.status === 'confirmed' || row.status === 'reverted'

function result(row: UserOpRow): UserOpResult {
  return {
    operationId: row.id,
    status: terminal(row)
      ? row.status === 'confirmed'
        ? 'confirmed'
        : 'reverted'
      : row.status === 'dropped'
        ? 'dropped'
        : 'pending',
    userOpHash: row.userop_hash,
    txHash: row.tx_hash,
    actualGasCost: row.actual_gas_cost,
  }
}

function aaFailure(error: sdk.AaError): AgentFailure {
  const transient = ['unavailable', 'uncertain', 'landed', 'refused'].includes(error.code)
  const code =
    error.code === 'bad-signature' || error.code === 'mismatch' ? 'forbidden' : transient ? 'unavailable' : 'conflict'
  // RPC errors may contain provider data. Return only static messages, never the RPC error text.
  const messages: Record<sdk.AaErrorCode, string> = {
    unavailable: 'The user operation service is unavailable; retry the same operationKey',
    uncertain: 'The send is uncertain; retry the same operationKey to reconcile it',
    landed: 'The nonce lane is spent; reconcile this operation before continuing',
    refused: 'The bundler refused this attempt; retry the same operationKey after resolving the refusal',
    ceiling: 'The USDC gas cost exceeds this network ceiling; nothing was sent',
    mismatch: 'The user operation service does not match the configured network policy',
    'bad-signature': 'The user operation signature does not match this agent',
    'no-paymaster': 'No USDC paymaster is configured on this network',
  }
  return new AgentFailure(code, messages[error.code], `aa-${error.code}`, transient ? 'same-key' : 'none')
}

/** Shared across desk instances constructed by concurrent requests in the management object. */
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const task = (queues.get(key) ?? Promise.resolve()).then(run)
  const barrier = task.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, barrier)
  try {
    return await task
  } finally {
    if (queues.get(key) === barrier) queues.delete(key)
  }
}

export class UserOpDesk implements UserOpSubmitter {
  constructor(
    readonly deps: {
      readonly rpc: UserOpRpc
      readonly signing: AgentSigning
      readonly context: sdk.Ctx
      readonly store: UserOpStore
      readonly now: () => number
    },
  ) {}

  #scope(agentId: string, operationId: Hex, evidenceCall?: sdk.Call): AgentBatchScope {
    const agent = this.deps.signing.agents.get(agentId)
    if (agent.address === null || agent.state !== 'active' || agent.chain_id !== this.deps.context.deployment.chainId)
      throw new AgentFailure('forbidden', 'Agent is not active on this chain', 'agent-unavailable', 'none')
    return {
      context: this.deps.context,
      grants: this.deps.signing.grants,
      agent: { ...agent, address: agent.address },
      operationId,
      now: this.deps.now(),
      agentSweep: this.deps.context.deployment.agentSweep,
      ...(evidenceCall === undefined ? {} : { evidenceCall }),
    }
  }

  #aa(): sdk.AccountAbstraction {
    const aa = this.deps.context.deployment.aa
    if (aa === null || aa.paymaster === null) throw aaFailure(new sdk.AaError('no-paymaster', ''))
    return aa
  }

  async ready(agentId: string): Promise<void> {
    this.#aa()
    await requireGasBudget(this.#scope(agentId, sdk.EMPTY_HASH))
  }

  submit(input: UserOpInput): Promise<UserOpResult> {
    const scope = this.#scope(input.agentId, input.id, input.evidenceCall)
    return serial(`${this.deps.context.deployment.chainId}:${scope.agent.address.toLowerCase()}`, async () => {
      try {
        return await this.#submit(input)
      } catch (error) {
        if (error instanceof sdk.AaError) throw aaFailure(error)
        throw error
      }
    })
  }

  async #submit(input: UserOpInput): Promise<UserOpResult> {
    const aa = this.#aa()
    const scope = this.#scope(input.agentId, input.id, input.evidenceCall)
    // No RPC, build, signature or money-moving call precedes this identity record.
    let row = this.deps.store.begin({
      id: input.id,
      agentId: input.agentId,
      sender: scope.agent.address,
      request: canonicalAgentArgs({
        calls: input.calls.map(freezeCall),
        evidenceCall: input.evidenceCall === undefined ? null : freezeCall(input.evidenceCall),
      }),
      fromBlock: 0n,
    })
    row = await this.#reconcile(row)
    if (terminal(row) || ['pending', 'uncertain', 'spent'].includes(row.status)) return result(row)
    await this.ready(input.agentId)
    if (['building', 'dropped'].includes(row.status)) {
      const built = await sdk.buildUserOp({
        aa,
        chainId: this.deps.context.deployment.chainId,
        ...this.deps.rpc,
        sender: scope.agent.address,
        calls: (maxCost) => withGasFloat(scope, input.calls, maxCost),
        nonceKey: sdk.nonceKey(input.id),
        authorization: await this.#authorization(input.agentId, scope.agent.address),
        minCallGas: hostedBatchGasFloor(this.deps.context, input.calls),
      })
      row = this.deps.store.built(input.id, built)
    }
    const built = thawUserOp(row.built_json!)
    if (row.status === 'built') {
      const signature = await this.deps.signing.signUserOperation(input.agentId, input.id, built.op, (calls) =>
        checkAgentBatch(this.#scope(input.agentId, input.id, input.evidenceCall), calls),
      )
      this.deps.store.signed(input.id, signature)
    }
    // Mark the attempt uncertain atomically BEFORE sending. A crash on either side of the RPC must reconcile.
    row = this.deps.store.outcome(input.id, 'uncertain', 'uncertain', true)
    const signed = thawUserOp(row.built_json!)
    try {
      await sdk.sendUserOp(this.deps.rpc.bundler, signed, signed.op.signature)
      row = this.deps.store.outcome(input.id, 'pending', 'pending')
    } catch (error) {
      if (error instanceof sdk.AaError && error.code === 'uncertain') return result(row)
      this.deps.store.outcome(input.id, 'dropped', 'refused')
      throw error
    }
    return result(await this.#reconcile(row))
  }

  async operation(id: string): Promise<UserOpResult | undefined> {
    const row = this.deps.store.operation(id)
    if (row === undefined) return undefined
    return serial(`${this.deps.context.deployment.chainId}:${row.sender.toLowerCase()}`, async () => {
      try {
        return result(await this.#reconcile(this.deps.store.require(id)))
      } catch (error) {
        if (error instanceof sdk.AaError) throw aaFailure(error)
        throw error
      }
    })
  }

  async #receipt(row: UserOpRow): Promise<UserOpRow | undefined> {
    for (const attempt of this.deps.store.attempts(row.id).toReversed()) {
      const receipt = await sdk.userOpReceipt(this.deps.rpc.bundler, attempt.userop_hash)
      if (receipt !== null) return this.deps.store.finish(row.id, attempt.userop_hash, receipt)
    }
    return undefined
  }

  async #reconcile(row: UserOpRow): Promise<UserOpRow> {
    if (terminal(row)) return row
    const received = await this.#receipt(row)
    if (received !== undefined) return received
    if (row.status === 'spent') return (await this.#landed(row)) ?? row
    const aa = this.#aa()
    if ((await sdk.laneSequence(this.deps.rpc.node, aa.entryPoint, row.sender, BigInt(row.nonce_key))) !== 0n) {
      row = this.deps.store.spent(row.id)
      const landed = await this.#landed(row)
      // A spent lane is never rebuilt, even if the node has not returned its event yet.
      return landed ?? row
    }
    const attempt = this.deps.store.attempts(row.id).at(-1)
    if (attempt?.sent_at === null || attempt === undefined) return row
    if (this.deps.now() - attempt.sent_at < 120) return this.deps.store.waiting(row.id)
    return this.deps.store.outcome(row.id, 'dropped', 'dropped')
  }

  async #landed(row: UserOpRow): Promise<UserOpRow | undefined> {
    const aa = this.#aa()
    // Attempts have no sent-block field yet; the helper clamps this fallback to latest - 5000, never deployBlock.
    const event = await sdk.findUserOpEvent(
      this.deps.rpc.node,
      aa.entryPoint,
      row.sender,
      sdk.laneNonce(BigInt(row.nonce_key)),
      0n,
    )
    if (event === null) return undefined
    return this.deps.store.finish(row.id, event.userOpHash, {
      status: event.success ? 'success' : 'reverted',
      txHash: event.txHash,
      actualGasCost: event.actualGasCost,
    })
  }

  async #authorization(agentId: string, sender: Address): Promise<sdk.SignedAuthorization | undefined> {
    const code = hexField(await this.deps.rpc.node('eth_getCode', [sender, 'latest']), 'account code')
    if (code.toLowerCase() === `0xef0100${this.deps.context.deployment.delegation.delegator.slice(2).toLowerCase()}`)
      return undefined
    if (code !== '0x')
      throw new AgentFailure(
        'conflict',
        'This agent account delegates to another implementation',
        'account-code',
        'none',
      )
    const nonce = quantity(await this.deps.rpc.node('eth_getTransactionCount', [sender, 'pending']), 'upgrade nonce')
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new AgentFailure('conflict', 'Agent upgrade nonce is too large', 'upgrade-nonce', 'none')
    const authorization = await this.deps.signing.signUpgrade(agentId, Number(nonce))
    if (authorization.yParity === undefined)
      throw new AgentFailure('unavailable', 'Upgrade signature has no parity', 'upgrade-signature', 'none')
    return { ...authorization, yParity: authorization.yParity }
  }
}
