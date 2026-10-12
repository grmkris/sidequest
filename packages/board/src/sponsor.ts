/** ERC-7710 gas sponsorship. Only the relay signs transactions; the wallet signs its own bounded delegation. */
import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  type LocalAccount,
  getAddress,
  isAddress,
  keccak256,
  recoverAddress,
  stringToHex,
} from 'viem'
import {
  type Delegation,
  callsMade,
  delegationDigest,
  delegationHash,
  delegationTypedData,
  disableCalldata,
  isDisabled,
  parseDelegation,
} from '@sidequest/sdk'
import type { Sql } from './store.ts'
import { migrateAgentSchema } from './agent-schema.ts'
import { RelaySender, withRelayNonce } from './relay.ts'
import { type SponsorOperation as Operation, type SponsorResult, SponsorRecovery } from './sponsor-recovery.ts'
import { SPONSOR_LIMITS, sponsorBudget, sponsorRelayFloor } from './sponsor-policy.ts'
import { GrantStore, type GrantRow } from './grants.ts'
import { checkGrantCall, checkHireFunding, type GrantCall, type CheckedGrantCall } from './grant-calls.ts'

const min = (a: bigint, b: bigint) => (a < b ? a : b)
import { redeemGrantBatch } from './hire-batch.ts'
export { SPONSOR_LIMITS, sponsorBudget } from './sponsor-policy.ts'
export type { SponsorResult } from './sponsor-recovery.ts'

/** One object in the existing Board namespace, shared by every tenant and both transports. */
export const SPONSOR_OBJECT_NAME = '__hosted_sponsor_v1__'
export const sponsorToolNames = new Set([
  'sponsor_status',
  'sponsor_prepare',
  'sponsor_confirm',
  'sponsor_revoke',
  'sponsor_submit',
  'sponsor_operation',
])

export interface SponsorCall {
  readonly to: string
  readonly data: string
  readonly value?: string
  readonly chainId?: number
}
export interface SponsorDeps {
  readonly sql: Sql
  readonly now: () => number
  readonly ctx: sdk.Ctx
  readonly relay?: { readonly account: LocalAccount; readonly rpcUrl: string }
  readonly fail: (
    code: 'unauthenticated' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'chain',
    message: string,
  ) => Error
}
export interface NamedSponsorEntry {
  readonly grant: Hex
  readonly calls: readonly GrantCall[]
}
interface Grant {
  delegator: string
  delegation_json: string
  delegation_hash: string
  signature: string | null
  status: string
  expires_at: number
}
export type SponsorStatus = {
  status: 'none' | 'live' | 'expired' | 'used' | 'revoked'
  typedData: string | null
  delegationHash: Hex | null
  callsUsed: number
}
const eq = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
/** Serialized across awaits, including status/prepare/revoke, so concurrent calls cannot change a grant mid-send. */
export class SponsorDesk {
  readonly #d: SponsorDeps
  #queue: Promise<unknown> = Promise.resolve()
  constructor(deps: SponsorDeps) {
    this.#d = deps
    migrateAgentSchema(deps.sql)
    deps.sql.run(`CREATE TABLE IF NOT EXISTS sponsor_operations (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, delegation_hash TEXT NOT NULL, status TEXT NOT NULL,
      raw_tx TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, relay TEXT NOT NULL, nonce INTEGER NOT NULL,
      cost TEXT, reserved_cost TEXT NOT NULL, charged_day INTEGER, calls INTEGER NOT NULL, baseline_calls INTEGER NOT NULL,
      created_at INTEGER NOT NULL, action_key TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(wallet,action_key)
    )`)
    deps.sql.run('CREATE INDEX IF NOT EXISTS sponsor_operations_time ON sponsor_operations(created_at)')
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn)
    this.#queue = result.catch(() => undefined)
    return result
  }
  #grantSerial<T>(fn: () => Promise<T>): Promise<T> {
    return this.#serial(() => withRelayNonce(this.#ctx().deployment.relay, fn))
  }
  #ctx(): sdk.Ctx {
    const ctx = this.#d.ctx
    if (ctx.stack.kind !== 'sidequest-v1' || ctx.deployment.sidequest === null)
      throw this.#d.fail('conflict', 'sponsorship requires a deployed Sidequest v1 stack')
    return ctx
  }
  #relay() {
    const relay = this.#d.relay
    if (relay === undefined || !eq(relay.account.address, this.#ctx().deployment.relay))
      throw this.#refuse('unavailable', 'the configured sponsorship relay is unavailable')
    return relay
  }
  #wallet(text: string): Address {
    if (typeof text !== 'string' || !isAddress(text)) throw this.#d.fail('invalid', 'wallet must be an address')
    return getAddress(text)
  }
  #refuse(
    reason: 'policy' | 'simulation' | 'cap' | 'floor' | 'rate' | 'unavailable' | 'pending',
    message: string,
  ): Error {
    // Nothing was sent: a same-key retry is safe. Policy and simulation refusals will not change on retry.
    const retry = reason === 'policy' || reason === 'simulation' ? 'none' : 'same-key'
    const retryAfter =
      reason === 'floor'
        ? 600
        : reason === 'pending'
          ? 15
          : reason === 'rate'
            ? 300
            : reason === 'cap'
              ? 3600
              : undefined
    return Object.assign(
      this.#d.fail(reason === 'policy' ? 'forbidden' : reason === 'simulation' ? 'chain' : 'conflict', message),
      { reason, retry, ...(retryAfter === undefined ? {} : { retryAfter }) },
    )
  }
  #row(wallet: string): Grant | undefined {
    return this.#d.sql.all<Grant>(
      "SELECT * FROM grants WHERE delegator = ? AND kind='operator' ORDER BY expires_at DESC, rowid DESC LIMIT 1",
      wallet.toLowerCase(),
    )[0]
  }
  #delegation(wallet: Address, salt: bigint, expires: number): Delegation {
    return sdk.buildGrant(this.#ctx(), {
      kind: 'operator',
      delegator: wallet,
      salt,
      start: expires - SPONSOR_LIMITS.validity,
    })
  }
  #current(row: Grant): Delegation {
    const x = parseDelegation(row.delegation_json)
    if (delegationHash(this.#delegation(this.#wallet(row.delegator), x.salt, row.expires_at)) !== row.delegation_hash)
      throw this.#d.fail('conflict', 'sponsorship policy changed; revoke and prepare a new delegation')
    return { ...x, signature: row.signature as Hex }
  }
  async #status(wallet: Address): Promise<SponsorStatus> {
    const ctx = this.#ctx(),
      row = this.#row(wallet)
    if (row === undefined || row.status === 'prepared')
      return { status: 'none', typedData: null, delegationHash: null, callsUsed: 0 }
    // Unavailable chain state must error, never claim unused permission or an enabled delegation.
    const [used, disabled] = await Promise.all([
      callsMade(ctx, row.delegation_hash as Hex),
      isDisabled(ctx, row.delegation_hash as Hex),
    ])
    const status =
      row.status === 'revoked' || disabled
        ? 'revoked'
        : this.#d.now() >= row.expires_at
          ? 'expired'
          : used >= BigInt(SPONSOR_LIMITS.calls)
            ? 'used'
            : 'live'
    return {
      status,
      typedData: delegationTypedData(ctx.deployment, parseDelegation(row.delegation_json)),
      delegationHash: row.delegation_hash as Hex,
      callsUsed: Number(used),
    }
  }
  status(wallet: string) {
    return this.#serial(() => this.#status(this.#wallet(wallet)))
  }
  prepare(walletText: string) {
    return this.#grantSerial(async () => {
      const wallet = this.#wallet(walletText),
        ctx = this.#ctx()
      this.#relay()
      if ((await this.#status(wallet)).status === 'live')
        throw this.#d.fail('conflict', 'this wallet already has a live sponsorship delegation')
      const salt = BigInt(
        `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
      )
      const expires = this.#d.now() + SPONSOR_LIMITS.validity
      const x = this.#delegation(wallet, salt, expires)
      new GrantStore(this.#d.sql, ctx).prepare(wallet, {
        kind: 'operator',
        delegator: wallet,
        salt,
        start: expires - SPONSOR_LIMITS.validity,
      })
      const current = await sdk.delegationOf(ctx.publicClient, wallet)
      return {
        sign: { typedData: delegationTypedData(ctx.deployment, x) },
        upgrade: eq(current, ctx.deployment.delegation.delegator)
          ? null
          : { delegator: ctx.deployment.delegation.delegator },
      }
    })
  }
  confirm(walletText: string, signature: string) {
    return this.#grantSerial(async () => {
      const wallet = this.#wallet(walletText),
        ctx = this.#ctx(),
        row = this.#row(wallet)
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature))
        throw this.#d.fail('invalid', 'signature must be a 65-byte hex signature')
      if (row === undefined || (row.status !== 'prepared' && row.status !== 'live'))
        throw this.#d.fail('conflict', 'start with sponsor_prepare')
      if (row.expires_at <= this.#d.now())
        throw this.#d.fail('conflict', 'prepare a new sponsorship delegation; this one expired')
      const x = this.#current(row)
      const signer = await recoverAddress({
        hash: delegationDigest(ctx.deployment, x),
        signature: signature as Hex,
      }).catch(() => null)
      if (!eq(signer, wallet))
        throw this.#d.fail('forbidden', 'the signature is not the wallet’s over the prepared delegation')
      if (row.signature !== null && !eq(row.signature, signature))
        throw this.#d.fail('conflict', 'the prepared signature cannot change')
      if (!eq(await sdk.delegationOf(ctx.publicClient, wallet), ctx.deployment.delegation.delegator))
        throw this.#d.fail('conflict', 'upgrade the wallet to the DeleGator before confirming sponsorship')
      if (await isDisabled(ctx, row.delegation_hash as Hex))
        throw this.#d.fail('conflict', 'this delegation is disabled on-chain')
      this.#d.sql.run(
        "UPDATE grants SET signature=?, status='live' WHERE delegation_hash=?",
        signature,
        row.delegation_hash,
      )
      return this.#status(wallet)
    })
  }
  revoke(walletText: string) {
    return this.#grantSerial(async () => {
      const wallet = this.#wallet(walletText),
        ctx = this.#ctx(),
        row = this.#row(wallet)
      this.#d.sql.run("UPDATE grants SET status='revoked' WHERE delegator=? AND kind='operator'", wallet.toLowerCase())
      const transactions: sdk.TxRequest[] = []
      if (row !== undefined && row.signature !== null && !(await isDisabled(ctx, row.delegation_hash as Hex)))
        transactions.push({
          description: 'Disable the sponsorship delegation',
          chainId: ctx.deployment.chainId,
          to: ctx.deployment.delegation.manager,
          data: disableCalldata(parseDelegation(row.delegation_json)),
          value: '0',
        })
      return { transactions }
    })
  }
  #validate(wallet: Address, entries: readonly NamedSponsorEntry[]) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > SPONSOR_LIMITS.batch)
      throw this.#d.fail('invalid', `provide 1-${SPONSOR_LIMITS.batch} named grant entries`)
    const ctx = this.#ctx()
    const store = new GrantStore(this.#d.sql, ctx)
    const parsed: Array<{ row: GrantRow; spec: sdk.GrantSpec; grant: Delegation; checked: CheckedGrantCall }> = []
    for (const entry of entries) {
      if (typeof entry?.grant !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(entry.grant))
        throw this.#d.fail('invalid', 'every named grant must be a delegation hash')
      if (!Array.isArray(entry.calls)) throw this.#d.fail('invalid', 'every named grant must contain calls')
      const row = store.get(entry.grant)
      if (row === undefined || row.signature === null || row.status !== 'live' || row.expires_at <= this.#d.now())
        throw this.#d.fail('conflict', 'every named grant must be live and signed')
      if (!eq(row.delegator, wallet) || !eq(row.delegate, ctx.deployment.relay))
        throw this.#d.fail('forbidden', 'a named grant must belong to this wallet and delegate to the relay')
      const spec = store.spec(entry.grant)
      if (spec.kind.startsWith('agent-') || spec.kind === 'unstake') {
        const agent = this.#d.sql.all<{ operator: string; state: string; chain_id: number }>(
          'SELECT operator,state,chain_id FROM agents WHERE address=?',
          wallet.toLowerCase(),
        )[0]
        if (
          agent === undefined ||
          !eq(agent.operator, row.owner) ||
          agent.chain_id !== ctx.deployment.chainId ||
          (agent.state === 'revoked' &&
            (spec.kind !== 'agent-work' ||
              entry.calls.length === 0 ||
              entry.calls.some((call: NamedSponsorEntry['calls'][number]) => {
                try {
                  return checkGrantCall(ctx, spec, call).method !== 'disableDelegation'
                } catch {
                  return true
                }
              })))
        )
          throw this.#d.fail('forbidden', 'the grant does not match a live bound agent and operator')
        if (spec.kind === 'agent-sweep' && !eq(spec.operator, row.owner))
          throw this.#d.fail('forbidden', 'the sweep recipient is not this agent operator')
      }
      if (spec.kind === 'unstake') store.approvedUnstake(row.owner, spec)
      const grant = store.signed(entry.grant)
      if (entry.calls.length === 0) throw this.#d.fail('invalid', 'each entry requires calls')
      for (const call of entry.calls) {
        try {
          parsed.push({ row, spec, grant, checked: checkGrantCall(ctx, spec, call) })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'invalid grant call'
          const error = message.includes('outside') ? this.#refuse('policy', message) : this.#d.fail('invalid', message)
          throw Object.assign(error, { cause })
        }
      }
    }
    if (parsed.length === 0 || parsed.length > SPONSOR_LIMITS.batch)
      throw this.#d.fail('invalid', `provide 1-${SPONSOR_LIMITS.batch} sponsored calls`)
    const owner = parsed[0]!.row.owner
    if (parsed.some((item) => !eq(item.row.owner, owner)))
      throw this.#d.fail('forbidden', 'all named grants must belong to the same operator')
    for (let index = 0; index < parsed.length; index++) {
      const item = parsed[index]!
      if (item.spec.kind !== 'agent-approve-once') continue
      const publish = parsed[index + 1]
      if (publish?.checked.method !== 'publish')
        throw this.#d.fail('forbidden', 'one-off approval must accompany its frozen publish')
      store.approvedHire(item.row.owner, item.spec, publish.checked.execution.callData)
    }
    const nested = new Map<Hex, { row: GrantRow; spec: sdk.GrantSpec; grant: Delegation; calls: number }>()
    const publishes = checkHireFunding(
      ctx,
      owner,
      wallet,
      parsed.map((item) => ({ spec: item.spec, checked: item.checked })),
      (hash) => {
        const row = store.get(hash)
        if (row === undefined || row.status !== 'live' || row.expires_at <= this.#d.now() || !eq(row.owner, owner))
          throw this.#d.fail('conflict', 'nested grant is not live for this operator')
        const result = { row, spec: store.spec(hash), grant: store.signed(hash), calls: 1 }
        const previous = nested.get(hash)
        if (previous === undefined) nested.set(hash, result)
        else previous.calls++
        return result
      },
    )
    return { parsed, nested, owner, publishes }
  }
  #recovery() {
    return new SponsorRecovery(this.#d.sql, this.#ctx(), this.#d.now, this.#d.relay?.account)
  }
  #resume(op: Operation, broadcast = true) {
    return this.#recovery().resume(op, broadcast)
  }
  ready(): Promise<void> {
    return this.#grantSerial(async () => {
      const relay = this.#relay()
      await new RelaySender(this.#d.sql, this.#ctx(), relay.account, relay.rpcUrl, this.#d.now).checkPendingLocked()
    })
  }

  submit(walletText: string, entries: readonly NamedSponsorEntry[], key: string, agentOperationId?: Hex) {
    return this.#serial(async (): Promise<SponsorResult> => {
      const wallet = this.#wallet(walletText)
      const id = keccak256(stringToHex(JSON.stringify([wallet.toLowerCase(), key])))
      const prior = this.#d.sql.all<Operation>('SELECT * FROM sponsor_operations WHERE id=?', id)[0]
      // An existing key always names the original send. A fresh-key refusal means nothing was sent; a retry must
      // therefore reconcile that send before checking the current grant, policy, keys, caps or replacement calls.
      if (prior !== undefined) return withRelayNonce(getAddress(prior.relay), () => this.#resume(prior))
      const ctx = this.#ctx(),
        relay = this.#relay()
      return withRelayNonce(relay.account.address, async () => {
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
          throw this.#d.fail(
            'invalid',
            'key must be 1-128 letters, digits, underscores or hyphens; reuse it only for retries of one action',
          )
        // Both ledgers recover before any fresh counters, nonce, simulation or cap reservation.
        try {
          await new RelaySender(this.#d.sql, ctx, relay.account, relay.rpcUrl, this.#d.now).checkPendingLocked()
        } catch {
          throw this.#refuse('pending', 'an earlier relay transaction is still pending; retry shortly')
        }
        const { parsed, nested, owner, publishes } = this.#validate(wallet, entries)
        const payloadHash = keccak256(
          stringToHex(
            JSON.stringify(
              parsed.map((item) => [
                item.row.delegation_hash,
                item.checked.execution.target.toLowerCase(),
                item.checked.execution.callData,
                '0',
              ]),
            ),
          ),
        )
        const counted = new Map<Hex, { row: GrantRow; spec: sdk.GrantSpec; baseline: number; calls: number }>()
        for (const item of parsed) {
          const hash = item.row.delegation_hash
          const existing = counted.get(hash)
          if (existing !== undefined) existing.calls++
          else
            counted.set(hash, {
              row: item.row,
              spec: item.spec,
              baseline: Number(await callsMade(ctx, hash)),
              calls: 1,
            })
        }
        for (const [hash, item] of nested) {
          const existing = counted.get(hash)
          if (existing !== undefined) existing.calls += item.calls
          else
            counted.set(hash, {
              row: item.row,
              spec: item.spec,
              baseline: Number(await callsMade(ctx, hash)),
              calls: item.calls,
            })
        }
        for (const [hash, item] of counted) {
          if (await isDisabled(ctx, hash)) throw this.#d.fail('conflict', 'a named grant is disabled')
          if (sdk.grantHasCallLimit(item.spec) && item.baseline + item.calls > sdk.grantCallLimit(item.spec))
            throw this.#refuse('cap', 'the sponsorship call limit is exhausted')
        }
        const row = parsed[0]!.row
        const baseline = counted.get(row.delegation_hash)!.baseline
        const data = redeemGrantBatch(parsed.map((item) => ({ grant: item.grant, execution: item.checked.execution })))
        // ADR-0011 inner limits plus manager overhead are used only if estimation is unreliable.
        const floor = parsed.reduce((sum, c) => sum + c.checked.floor, 100_000n)
        const gas = await sdk
          .transactionGas(
            ctx.publicClient,
            { account: relay.account, to: ctx.deployment.delegation.manager, data },
            { fallback: floor, margin: SPONSOR_LIMITS.gasMargin },
          )
          .catch((cause) => {
            throw Object.assign(this.#refuse('simulation', 'the sponsored calls did not simulate successfully'), {
              cause,
            })
          })
        if (gas > SPONSOR_LIMITS.gas) throw this.#refuse('cap', 'the sponsored transaction exceeds the gas cap')
        const { maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas } = await sdk.transactionFees(ctx.publicClient)
        // The send may pay up to its cap (twice the base fee), which it reserves; the budget and the floor count what it
        // will most likely pay (Monad bills the whole limit at base fee plus tip), so the relay is not refused early.
        const cost = gas * maxFeePerGas
        const expected = gas * min(maxFeePerGas, baseFeePerGas + maxPriorityFeePerGas)
        const day = Math.floor(this.#d.now() / 86400) * 86400
        const daily = this.#d.sql.all<{ cost: string }>(
          'SELECT cost FROM sponsor_operations WHERE charged_day=? AND cost IS NOT NULL UNION ALL SELECT cost FROM sponsor_replacements WHERE charged_day=? AND cost IS NOT NULL',
          day,
          day,
        )
        // Charge only receipts. All unresolved sends were reconciled above; this send counts its expected cost.
        if (
          daily.reduce((sum, op) => sum + BigInt(op.cost!), expected) > sponsorBudget(ctx.deployment.network).dailyWei
        )
          throw this.#refuse('cap', 'the relay’s daily sponsorship budget is exhausted')
        const recent = this.#d.sql.all<{ calls: number }>(
          'SELECT calls FROM sponsor_operator_usage WHERE owner=? AND created_at > ?',
          owner.toLowerCase(),
          this.#d.now() - SPONSOR_LIMITS.walletWindow,
        )
        if (
          recent.reduce((sum, op) => sum + op.calls, parsed.length) > sponsorBudget(ctx.deployment.network).walletCalls
        )
          throw this.#refuse('rate', 'the operator sponsorship rate limit is exhausted')
        const dailyPublishes = this.#d.sql.all<{ publishes: number }>(
          'SELECT coalesce(sum(publishes),0) publishes FROM sponsor_operator_usage WHERE owner=? AND created_at>=?',
          owner.toLowerCase(),
          day,
        )[0]!.publishes
        if (dailyPublishes + publishes > SPONSOR_LIMITS.operatorPublishes)
          throw this.#refuse('cap', 'the operator daily sponsored publish count is exhausted')
        // Pending sends this desk made are settled above; the pending balance also counts any other send in flight.
        if (
          (await ctx.publicClient.getBalance({ address: relay.account.address, blockTag: 'pending' })) <
          sponsorRelayFloor(ctx.deployment.network) + expected
        )
          throw this.#refuse('floor', 'the sponsorship relay is below its balance floor')
        const nonce = await ctx.publicClient.getTransactionCount({
          address: relay.account.address,
          blockTag: 'pending',
        })
        const raw = await relay.account.signTransaction({
          type: 'eip1559',
          chainId: ctx.deployment.chainId,
          nonce,
          to: ctx.deployment.delegation.manager,
          data,
          value: 0n,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        })
        const hash = keccak256(raw)
        // The signed send, every counter reservation and its agent-operation link commit together before broadcast.
        if (this.#d.sql.atomic === undefined) throw this.#d.fail('chain', 'atomic sponsor storage is unavailable')
        this.#d.sql.atomic(() => {
          this.#d.sql.run(
            "INSERT INTO sponsor_operations (id,wallet,delegation_hash,status,raw_tx,tx_hash,relay,nonce,reserved_cost,calls,baseline_calls,created_at,action_key,payload_hash) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)",
            id,
            wallet.toLowerCase(),
            row.delegation_hash,
            raw,
            hash,
            relay.account.address,
            nonce,
            cost.toString(),
            parsed.length,
            baseline,
            this.#d.now(),
            key,
            payloadHash,
          )
          for (const [grantHash, item] of counted)
            this.#d.sql.run(
              'INSERT INTO sponsor_entry_grants (operation_id,delegation_hash,baseline_calls,calls) VALUES (?,?,?,?)',
              id,
              grantHash,
              item.baseline,
              item.calls,
            )
          this.#d.sql.run(
            'INSERT INTO sponsor_operator_usage (operation_id,owner,calls,publishes,created_at) VALUES (?,?,?,?,?)',
            id,
            owner.toLowerCase(),
            parsed.length,
            publishes,
            this.#d.now(),
          )
          if (agentOperationId !== undefined) {
            const operation = this.#d.sql.all<{
              stage: string
              sponsor_operation_id: string | null
              address: string
              state: string
            }>(
              'SELECT agent_operations.stage,agent_operations.sponsor_operation_id,agents.address,agents.state FROM agent_operations JOIN agents ON agents.id=agent_operations.agent_id WHERE agent_operations.id=?',
              agentOperationId,
            )[0]
            if (
              operation === undefined ||
              !eq(operation.address, wallet) ||
              operation.state === 'revoked' ||
              operation.sponsor_operation_id !== null ||
              !['prepared', 'signed', 'approval'].includes(operation.stage)
            )
              throw this.#d.fail('conflict', 'agent operation is not ready for this send')
            this.#d.sql.run(
              "UPDATE agent_operations SET stage='sending',sponsor_operation_id=?,updated_at=? WHERE id=?",
              id,
              this.#d.now(),
              agentOperationId,
            )
          }
        })
        return this.#resume(this.#d.sql.all<Operation>('SELECT * FROM sponsor_operations WHERE id=?', id)[0]!)
      })
    })
  }

  operation(walletText: string, operationId: string) {
    return this.#serial(async () => {
      const wallet = this.#wallet(walletText)
      const row = this.#d.sql.all<Operation>(
        'SELECT * FROM sponsor_operations WHERE id=? AND wallet=?',
        operationId,
        wallet.toLowerCase(),
      )[0]
      if (row === undefined) throw this.#d.fail('not-found', 'no sponsorship operation for this wallet')
      return withRelayNonce(getAddress(row.relay), () => this.#resume(row, false))
    })
  }
}
