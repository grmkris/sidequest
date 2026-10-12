/** Separate operator-funded USDC gas budgets. Replacement and revocation are operator-sent. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { AgentStore, type AgentRow } from './agents.ts'
import { GrantStore, type GrantRow } from './grants.ts'
import { allowanceAvailable } from './agent-call-mapper.ts'
import type { Sql } from './store.ts'
import { AgentFailure } from './agent-failure.ts'

interface GasRequest {
  hash: Hex
  previous: Hex[]
}
interface GasRequests {
  gasAllowances?: Record<string, GasRequest>
}
export interface GasAllowanceInput {
  readonly key: string
  readonly amount?: bigint
  readonly periodSeconds?: number
}

export class GasAllowances {
  readonly agents: AgentStore
  readonly grants: GrantStore
  constructor(readonly deps: { readonly sql: Sql; readonly context: sdk.Ctx; readonly now: () => number }) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.grants = new GrantStore(deps.sql, deps.context)
  }

  #rows(agent: AgentRow): GrantRow[] {
    return this.grants
      .list(agent.operator)
      .filter(
        (row) =>
          row.kind === 'gas-allowance' &&
          row.delegate.toLowerCase() === agent.address?.toLowerCase() &&
          row.owner.toLowerCase() === agent.operator.toLowerCase(),
      )
  }

  #requests(agent: AgentRow): Record<string, GasRequest> {
    // SAFETY: only prepare below writes gasAllowances into this server-owned onboarding journal.
    return (JSON.parse(agent.onboarding_json) as GasRequests).gasAllowances ?? {}
  }

  #previous(agent: AgentRow, except?: Hex): Hex[] {
    return this.#rows(agent)
      .filter(
        (row) =>
          row.delegation_hash !== except &&
          row.signature !== null &&
          row.status !== 'disabled' &&
          row.expires_at > this.deps.now(),
      )
      .map((row) => row.delegation_hash)
  }

  #disableCalls(hashes: readonly Hex[]): sdk.TxRequest[] {
    return hashes.map((hash) => {
      const row = this.grants.get(hash)!
      const grant = { ...sdk.parseDelegation(row.delegation_json), signature: row.signature ?? '0x' }
      return {
        to: this.deps.context.deployment.delegation.manager,
        data: sdk.disableCalldata(grant),
        value: '0',
        chainId: this.deps.context.deployment.chainId,
        description: 'Disable the previous USDC gas budget',
      }
    })
  }

  prepare(id: string, operator: Address, input: GasAllowanceInput) {
    const agent = this.agents.owned(id, operator)
    const aa = this.deps.context.deployment.aa
    if (agent.state !== 'active' || agent.address === null || aa === null)
      throw new AgentFailure(
        'conflict',
        'The agent must be active on a configured AA network',
        'agent-unavailable',
        'none',
      )
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.key)) throw new Error('Persist a stable gas budget request key')
    const amount = input.amount ?? sdk.GAS_ALLOWANCE_AMOUNT
    const periodSeconds = input.periodSeconds ?? sdk.ALLOWANCE_PERIOD
    if (
      amount <= 0n ||
      amount >= 1n << 256n ||
      !Number.isSafeInteger(periodSeconds) ||
      periodSeconds <= 0 ||
      periodSeconds > sdk.ALLOWANCE_VALIDITY
    )
      throw new Error('Gas budget requires a positive USDC limit and period of at most 30 days')
    const requests = this.#requests(agent)
    const prior = requests[input.key]
    const spec: sdk.GrantSpec =
      prior === undefined
        ? {
            kind: 'gas-allowance',
            delegator: operator,
            agent: agent.address,
            token: aa.gasToken,
            amount,
            periodSeconds,
            salt: BigInt(keccak256(stringToHex(JSON.stringify(['gas-allowance', id, input.key])))),
            start: this.deps.now(),
          }
        : this.grants.spec(prior.hash)
    if (spec.kind !== 'gas-allowance' || spec.amount !== amount || spec.periodSeconds !== periodSeconds)
      throw new Error('Gas budget request key changed')
    const prepared = this.grants.prepare(operator, spec)
    const previous = [...new Set([...(prior?.previous ?? []), ...this.#previous(agent, prepared.hash)])]
    requests[input.key] = { hash: prepared.hash, previous }
    // SAFETY: the onboarding journal is a server-owned JSON object and this preserves its other fields.
    const onboarding = JSON.parse(agent.onboarding_json) as Record<string, unknown>
    this.agents.updateOnboarding(id, { ...onboarding, gasAllowances: requests })
    return { ...prepared, previous, transactions: this.#disableCalls(previous) }
  }

  async confirm(id: string, operator: Address, key: string, hash: Hex, signature: Hex) {
    const agent = this.agents.owned(id, operator)
    const request = this.#requests(agent)[key]
    if (agent.state !== 'active' || request?.hash !== hash || this.grants.get(hash)!.expires_at <= this.deps.now())
      throw new Error('Gas allowance differs from the live persisted operator request')
    await this.grants.verifySignature(hash, signature)
    const previous = [...new Set([...request.previous, ...this.#previous(agent, hash)])]
    for (const prior of previous) {
      const row = this.grants.get(prior)!
      if (row.expires_at > this.deps.now() && !(await sdk.isDisabled(this.deps.context, prior)))
        throw new AgentFailure(
          'conflict',
          'Disable the previous gas budget from the operator wallet before confirming its replacement',
          'gas-budget-disable-required',
          'after-operator',
        )
      this.deps.sql.run("UPDATE grants SET status='disabled' WHERE delegation_hash=?", prior)
    }
    await this.grants.confirm(hash, signature)
    return { hash, status: 'live' as const, gasAllowances: await this.status(agent) }
  }

  async revoke(id: string, operator: Address, hash: Hex) {
    const agent = this.agents.owned(id, operator)
    const row = this.#rows(agent).find((item) => item.delegation_hash === hash)
    if (row === undefined || row.signature === null) throw new Error('No such signed gas allowance for this agent')
    this.grants.stop(hash)
    const disabled = await sdk.isDisabled(this.deps.context, hash)
    if (disabled) this.deps.sql.run("UPDATE grants SET status='disabled' WHERE delegation_hash=?", hash)
    return { hash, status: disabled ? 'disabled' : 'revoked', transactions: disabled ? [] : this.#disableCalls([hash]) }
  }

  async status(agent: AgentRow) {
    return Promise.all(
      this.#rows(agent).map(async (row) => {
        const spec = this.grants.spec(row.delegation_hash)
        if (spec.kind !== 'gas-allowance') throw new Error('Not a gas allowance')
        const now = this.deps.now()
        const left = row.expires_at <= now ? 0n : await allowanceAvailable(this.deps.context, this.grants, row)
        const period = Math.max(0, Math.floor((now - spec.start) / spec.periodSeconds))
        return {
          hash: row.delegation_hash,
          status: row.status,
          token: spec.token,
          limit: spec.amount.toString(),
          left: left.toString(),
          used: (spec.amount - left).toString(),
          periodSeconds: spec.periodSeconds,
          periodStart: spec.start + period * spec.periodSeconds,
          periodEnd: spec.start + (period + 1) * spec.periodSeconds,
          expiresAt: row.expires_at,
        }
      }),
    )
  }
}
