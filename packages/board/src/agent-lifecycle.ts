/** Operator decisions and revocation. Hosted state never stands in for a disable receipt. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { AgentPermissions } from './agent-permissions.ts'
import { AgentRoles } from './agent-roles.ts'
import { AgentStore, type AgentRow } from './agents.ts'
import { GrantStore, type GrantRow } from './grants.ts'
import { SponsorDesk } from './sponsor.ts'
import { allowanceAvailable } from './agent-call-mapper.ts'
import type { Sql } from './store.ts'

export interface AgentLifecycleDeps {
  readonly sql: Sql
  readonly context: sdk.Ctx
  readonly now: () => number
  readonly sponsor: SponsorDesk
}

interface AllowanceRequest {
  hash: Hex
  previous: Hex[]
}

function requestKey(id: string, key: string): bigint {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error('Persist a stable request key before preparing a permission')
  return BigInt(keccak256(stringToHex(JSON.stringify([id, key]))))
}

export class AgentLifecycle {
  readonly agents: AgentStore
  readonly grants: GrantStore

  constructor(readonly deps: AgentLifecycleDeps) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.grants = new GrantStore(deps.sql, deps.context)
  }

  async status(id: string, operator: Address) {
    const agent = this.agents.owned(id, operator)
    const now = this.deps.now()
    const connected =
      agent.state === 'active' &&
      this.deps.sql.all<{ connected: number }>(
        `SELECT 1 connected FROM agent_oauth_families f
       JOIN agent_oauth_tokens t ON t.family_id=f.id
       WHERE f.agent_id=? AND f.revoked_at IS NULL AND t.expires_at>?
         AND (t.kind='access' OR (t.kind='refresh' AND t.consumed_at IS NULL))
       LIMIT 1`,
        agent.id,
        now,
      ).length > 0
    const allowances = this.#allowances(agent).filter((row) => row.status === 'live' && row.kind === 'allowance')
    const usage = await Promise.all(
      allowances.map(async (row) => {
        const spec = this.grants.spec(row.delegation_hash)
        if (spec.kind !== 'allowance') throw new Error('Not a periodic allowance')
        const left = row.expires_at <= now ? 0n : await allowanceAvailable(this.deps.context, this.grants, row)
        const period = Math.max(0, Math.floor((now - spec.start) / sdk.ALLOWANCE_PERIOD))
        return {
          hash: row.delegation_hash,
          token: spec.token,
          limit: spec.amount.toString(),
          left: left.toString(),
          used: (spec.amount - left).toString(),
          periodStart: spec.start + period * sdk.ALLOWANCE_PERIOD,
          periodEnd: spec.start + (period + 1) * sdk.ALLOWANCE_PERIOD,
          expiresAt: row.expires_at,
        }
      }),
    )
    return {
      connected,
      agent,
      permissions: new AgentPermissions(this.deps).list(agent),
      allowances: usage,
      grants: this.grants
        .list(agent.address ?? operator)
        .map((row) => ({ hash: row.delegation_hash, kind: row.kind, status: row.status, expiresAt: row.expires_at })),
      revocation: {
        ...JSON.parse(agent.revoke_json),
        receipts: this.deps.sql.all<{ tx_hash: Hex; status: string }>(
          'SELECT tx_hash,status FROM sponsor_operations WHERE substr(action_key,1,?)=? ORDER BY created_at',
          `revoke-${id.slice(0, 60)}-`.length,
          `revoke-${id.slice(0, 60)}-`,
        ),
      } as Record<string, unknown>,
    }
  }

  #allowances(agent: AgentRow): GrantRow[] {
    // Operator → agent grants: allowances and permissions alike; revocation disables every one of them.
    return this.grants.list(agent.operator).filter((row) => {
      const spec = this.grants.spec(row.delegation_hash)
      return (
        (spec.kind === 'allowance' || spec.kind === 'allowance-once' || spec.kind === 'permission') &&
        spec.agent.toLowerCase() === agent.address?.toLowerCase()
      )
    })
  }

  prepareAllowance(id: string, operator: Address, input: { key: string; token: Address; amount: bigint }) {
    const agent = this.agents.owned(id, operator)
    if (agent.state !== 'active' || agent.address === null)
      throw new Error('The agent must be active before granting spending')
    const salt = requestKey(id, input.key)
    if (input.amount <= 0n) throw new Error('The spending limit must be positive')
    const onboarding = JSON.parse(agent.onboarding_json) as Record<string, unknown>
    const requests = (onboarding.allowances ?? {}) as Record<string, AllowanceRequest>
    const prior = requests[input.key]
    if (prior !== undefined) {
      const spec = this.grants.spec(prior.hash)
      if (
        spec.kind !== 'allowance' ||
        spec.token.toLowerCase() !== input.token.toLowerCase() ||
        spec.amount !== input.amount
      )
        throw new Error('Allowance request key changed')
      return this.grants.prepare(operator, spec)
    }
    const prepared = this.grants.prepare(operator, {
      kind: 'allowance',
      delegator: operator,
      agent: agent.address,
      token: input.token,
      amount: input.amount,
      start: this.deps.now(),
      salt,
    })
    requests[input.key] = {
      hash: prepared.hash,
      previous: this.#allowances(agent)
        .filter(
          (row) =>
            row.status === 'live' &&
            this.grants.spec(row.delegation_hash).kind === 'allowance' &&
            (
              this.grants.spec(row.delegation_hash) as Extract<sdk.GrantSpec, { kind: 'allowance' }>
            ).token.toLowerCase() === input.token.toLowerCase(),
        )
        .map((row) => row.delegation_hash),
    }
    this.agents.updateOnboarding(id, { ...onboarding, allowances: requests })
    return prepared
  }

  async confirmAllowance(id: string, operator: Address, key: string, hash: Hex, signature: Hex) {
    const agent = this.agents.owned(id, operator)
    if (agent.state !== 'active') throw new Error('Agent access has stopped')
    const requests = (JSON.parse(agent.onboarding_json) as { allowances?: Record<string, AllowanceRequest> }).allowances
    const request = requests?.[key]
    if (request === undefined || request.hash !== hash)
      throw new Error('Allowance differs from the persisted operator request')
    // Verify the signature without making this grant usable. Old authority must be disabled first.
    if (this.grants.get(hash)!.expires_at <= this.deps.now())
      throw new Error('This allowance expired; prepare and sign a new request')
    await this.grants.verifySignature(hash, signature)
    request.previous = [
      ...new Set([
        ...request.previous,
        ...this.#allowances(agent)
          .filter(
            (row) =>
              row.delegation_hash !== hash &&
              row.status === 'live' &&
              row.kind === 'allowance' &&
              (
                this.grants.spec(row.delegation_hash) as Extract<sdk.GrantSpec, { kind: 'allowance' }>
              ).token.toLowerCase() ===
                (this.grants.spec(hash) as Extract<sdk.GrantSpec, { kind: 'allowance' }>).token.toLowerCase(),
          )
          .map((row) => row.delegation_hash),
      ]),
    ]
    this.agents.updateOnboarding(id, { ...JSON.parse(agent.onboarding_json), allowances: requests })
    for (const previous of request.previous)
      await this.#disable(operator, previous, `allowance-${hash.slice(2, 26)}-${previous.slice(2, 26)}`)
    await this.grants.confirm(hash, signature)
    return this.status(id, operator)
  }

  prepareApproval(id: string, operator: Address, adjust: { expiry?: number; amount?: bigint; calls?: number } = {}) {
    const approval = this.agents.approval(id)
    const agent = this.agents.owned(approval.agent_id, operator)
    if (agent.state !== 'active' || approval.status !== 'pending') throw new Error('This approval is unavailable')
    if (approval.kind === 'unstake' || approval.kind === 'role') return { approval }
    if (approval.kind === 'permission') return new AgentPermissions(this.deps).prepare(approval, operator, adjust)
    const request = JSON.parse(approval.request_json) as { token: Address; amount: string }
    const operation = this.agents.operation(approval.operation_id)
    const history = this.deps.sql
      .all<{ name: string; value_json: string }>(
        "SELECT name,value_json FROM agent_operation_steps WHERE operation_id=? AND name LIKE 'operator-allowance:%'",
        operation.id,
      )
      .toSorted((a, b) => Number(b.name.split(':')[1]) - Number(a.name.split(':')[1]))
    const previous = history[0]
    const prior = previous === undefined ? undefined : (JSON.parse(previous.value_json) as { hash: Hex })
    const live = prior !== undefined && this.grants.get(prior.hash)!.expires_at > this.deps.now()
    const attempt = live ? Number(previous!.name.split(':')[1]) : Number(previous?.name.split(':')[1] ?? 0) + 1
    const prepared = this.grants.prepare(
      operator,
      !live
        ? {
            kind: 'allowance-once',
            delegator: operator,
            agent: agent.address!,
            token: request.token,
            amount: BigInt(request.amount),
            start: this.deps.now(),
            salt: requestKey(agent.id, `approval-${operation.id.slice(2)}-${attempt}`),
          }
        : this.grants.spec(prior!.hash),
    )
    this.agents.freezeStep(operation.id, `operator-allowance:${attempt}`, { hash: prepared.hash })
    return { approval, ...prepared }
  }

  async decideApproval(
    id: string,
    operator: Address,
    approved: boolean,
    signature?: Hex,
    permission: { hash?: Hex; standing?: boolean } = {},
  ) {
    const approval = this.agents.approval(id)
    const agent = this.agents.owned(approval.agent_id, operator)
    if (agent.state !== 'active') throw new Error('Agent access has stopped')
    if (approval.status !== 'pending') return approval
    if (approval.kind === 'permission') {
      return new AgentPermissions(this.deps).decide(approval, operator, {
        approved,
        ...(permission.hash === undefined ? {} : { hash: permission.hash }),
        ...(signature === undefined ? {} : { signature }),
        ...(permission.standing === undefined ? {} : { standing: permission.standing }),
      })
    }
    if (approval.kind === 'role') return new AgentRoles(this.agents).decide(approval, operator, approved)
    if (!approved) return this.agents.decide(id, operator, false, {})
    if (approval.kind === 'unstake') return this.agents.decide(id, operator, true, {})
    const prepared = this.prepareApproval(id, operator)
    if (
      !('hash' in prepared) ||
      signature === undefined ||
      this.grants.get(prepared.hash)!.expires_at <= this.deps.now()
    )
      throw new Error('Sign the current exact allowance before approving this hire')
    await this.grants.confirm(prepared.hash, signature)
    return this.agents.decide(id, operator, true, { allowanceHash: prepared.hash })
  }

  recoverApproval(id: string, operator: Address) {
    const approval = this.agents.approval(id)
    this.agents.owned(approval.agent_id, operator)
    if (approval.status !== 'approved' || approval.kind !== 'hire-over-limit') return approval
    const operation = this.agents.operation(approval.operation_id)
    if (operation.sponsor_operation_id !== null || ['sending', 'confirmed', 'failed'].includes(operation.stage))
      return approval
    const decision = JSON.parse(approval.decision_json ?? '{}') as { allowanceHash?: Hex }
    const current = decision.allowanceHash === undefined ? undefined : this.grants.get(decision.allowanceHash)
    if (current?.status === 'live' && current.expires_at > this.deps.now()) return approval
    return this.agents.reopenApproval(id)
  }

  async disablePermission(id: string, operator: Address, hash: Hex) {
    const agent = this.agents.owned(id, operator)
    const row = this.#allowances(agent).find(
      (item) => item.delegation_hash.toLowerCase() === hash.toLowerCase() && item.kind === 'permission',
    )
    if (row === undefined) throw new Error('No such permission for this agent')
    await this.deps.sponsor.ready()
    await this.#disable(operator, row.delegation_hash, `permission-${row.delegation_hash.slice(2)}`)
    return new AgentPermissions(this.deps).list(agent)
  }

  async #disable(wallet: Address, hash: Hex, key: string): Promise<void> {
    const row = this.grants.get(hash)
    if (row === undefined || row.signature === null) return
    const prior = this.deps.sql.all(
      'SELECT id FROM sponsor_operations WHERE wallet=? AND action_key=?',
      wallet.toLowerCase(),
      key,
    )[0]
    if (prior !== undefined) {
      const result = await this.deps.sponsor.submit(wallet, [], key)
      if (result.status !== 'confirmed')
        throw new Error(`Permission disable is ${result.status}; retry the original operation`)
    } else {
      // A receipt still has to exist to claim our workflow disabled a permission.
      const kinds = wallet.toLowerCase() === row.owner.toLowerCase() ? ['operator'] : ['agent-work']
      let authority: GrantRow | undefined
      const candidates = this.grants
        .list(wallet)
        .filter(
          (candidate) =>
            kinds.includes(candidate.kind) &&
            candidate.status === 'live' &&
            candidate.signature !== null &&
            candidate.expires_at > this.deps.now(),
        )
        .toSorted((a, b) => Number(a.delegation_hash === hash) - Number(b.delegation_hash === hash))
      for (const candidate of candidates) {
        if (
          !(await sdk.isDisabled(this.deps.context, candidate.delegation_hash)) &&
          (await sdk.callsMade(this.deps.context, candidate.delegation_hash)) < BigInt(sdk.GRANT_CALLS)
        ) {
          authority = candidate
          break
        }
      }
      if (authority === undefined)
        throw new Error('No usable gas grant remains to disable this permission; renew operator sponsorship')
      const grant = { ...sdk.parseDelegation(row.delegation_json), signature: row.signature }
      const result = await this.deps.sponsor.submit(
        wallet,
        [
          {
            grant: authority.delegation_hash,
            calls: [{ to: this.deps.context.deployment.delegation.manager, data: sdk.disableCalldata(grant) }],
          },
        ],
        key,
      )
      if (result.status !== 'confirmed')
        throw new Error(`Permission disable is ${result.status}; retry the original operation`)
    }
    if (!(await sdk.isDisabled(this.deps.context, hash)))
      throw new Error('The disable receipt does not match chain state')
    this.deps.sql.run("UPDATE grants SET status='disabled' WHERE delegation_hash=?", hash)
  }

  stopAccess(id: string, operator: Address) {
    const agent = this.agents.owned(id, operator)
    if (this.deps.sql.atomic === undefined) throw new Error('Revocation requires atomic storage')
    this.deps.sql.atomic(() => {
      this.agents.advance(id, 'revoked')
      this.deps.sql.run(
        'UPDATE agent_oauth_families SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL',
        this.deps.now(),
        id,
      )
      const previous = JSON.parse(agent.revoke_json) as Record<string, unknown>
      this.deps.sql.run(
        'UPDATE agents SET revoke_json=? WHERE id=?',
        JSON.stringify({ ...previous, hostedAccessStopped: true, stoppedAt: previous.stoppedAt ?? this.deps.now() }),
        id,
      )
    })
    return this.agents.get(id)
  }

  async revoke(id: string, operator: Address) {
    let agent = this.stopAccess(id, operator)
    await this.deps.sponsor.ready()
    if (agent.address === null) return this.status(id, operator)
    const rows = [...this.#allowances(agent), ...this.grants.list(agent.address)]
      .filter((row) => row.signature !== null && row.status !== 'disabled')
      .toSorted(
        (a, b) => Number(a.kind === 'agent-work') - Number(b.kind === 'agent-work') || a.expires_at - b.expires_at,
      )
    for (const row of rows)
      await this.#disable(
        row.delegator,
        row.delegation_hash,
        `revoke-${id.slice(0, 60)}-${row.delegation_hash.slice(2, 26)}`,
      )
    agent = this.agents.get(id)
    this.deps.sql.run(
      'UPDATE agents SET revoke_json=? WHERE id=?',
      JSON.stringify({
        ...JSON.parse(agent.revoke_json),
        onchainPermissionsDisabled: true,
        disabledAt: this.deps.now(),
      }),
      id,
    )
    return this.status(id, operator)
  }
}
