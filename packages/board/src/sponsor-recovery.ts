/** Shared sponsorship reconciliation for every sender in the relay nonce queue. */
import * as sdk from '@sidequest/sdk'
import {
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
  getAddress,
  keccak256,
  parseTransaction,
} from 'viem'
import { callsMade, isDisabled } from '@sidequest/sdk'
import type { Sql } from './store.ts'

const min = (a: bigint, b: bigint) => (a < b ? a : b)
import { sponsorRelayFloor } from './sponsor-policy.ts'

export interface SponsorOperation {
  id: string
  wallet: string
  delegation_hash: string
  status: string
  raw_tx: string
  tx_hash: string
  relay: string
  nonce: number
  cost: string | null
  reserved_cost: string
  charged_day: number | null
  calls: number
  baseline_calls: number
  created_at: number
  action_key: string
  payload_hash: string
}
interface Replacement {
  operation_id: string
  raw_tx: Hex
  tx_hash: Hex
  nonce: number
  status: string
}
export type SponsorResult = {
  operationId: string
  txHash: Hex
  status: 'pending' | 'confirmed' | 'reverted' | 'dropped'
  callsUsed: number
}
const bump = (fee: bigint) => (fee * 125n) / 100n + 1n
const max = (a: bigint, b: bigint) => (a > b ? a : b)

export class SponsorRecovery {
  constructor(
    readonly sql: Sql,
    readonly ctx: sdk.Ctx,
    readonly now: () => number,
    readonly account?: LocalAccount,
  ) {
    sql.run(`CREATE TABLE IF NOT EXISTS sponsor_replacements (operation_id TEXT PRIMARY KEY, raw_tx TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE, nonce INTEGER NOT NULL, status TEXT NOT NULL, cost TEXT, charged_day INTEGER)`)
  }
  async #receipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    try {
      return await this.ctx.publicClient.getTransactionReceipt({ hash })
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return undefined
      throw e
    }
  }
  async #charge(
    table: 'sponsor_operations' | 'sponsor_replacements',
    op: SponsorOperation,
    receipt: TransactionReceipt,
    status: string,
  ) {
    const block = await this.ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber })
    this.sql.run(
      `UPDATE ${table} SET status=?,cost=?,charged_day=? WHERE ${table === 'sponsor_operations' ? 'id' : 'operation_id'}=?`,
      status,
      (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      Math.floor(Number(block.timestamp) / 86400) * 86400,
      op.id,
    )
  }
  #drop(op: SponsorOperation) {
    this.sql.run("UPDATE sponsor_operations SET status='dropped' WHERE id=? AND status='pending'", op.id)
  }

  async #authority(op: SponsorOperation): Promise<{ live: boolean; countersUnchanged: boolean }> {
    const hasEntries =
      this.sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name='sponsor_entry_grants'").length > 0
    const entries = hasEntries
      ? this.sql.all<{ delegation_hash: Hex; baseline_calls: number }>(
          'SELECT delegation_hash,baseline_calls FROM sponsor_entry_grants WHERE operation_id=?',
          op.id,
        )
      : []
    // Existing sends retain their journal and signed bytes through the clean break, including those without an entry ledger.
    if (entries.length === 0)
      entries.push({ delegation_hash: op.delegation_hash as Hex, baseline_calls: op.baseline_calls })
    let live = true
    let countersUnchanged = true
    for (const entry of entries) {
      const grant = this.sql.all<{ status: string; expires_at: number }>(
        'SELECT status,expires_at FROM grants WHERE delegation_hash=?',
        entry.delegation_hash,
      )[0]
      if (
        grant?.status !== 'live' ||
        grant.expires_at <= this.now() ||
        (await isDisabled(this.ctx, entry.delegation_hash))
      )
        live = false
      if ((await callsMade(this.ctx, entry.delegation_hash)) !== BigInt(entry.baseline_calls)) countersUnchanged = false
    }
    return { live, countersUnchanged }
  }
  async #replacement(op: SponsorOperation): Promise<Replacement> {
    const [saved] = this.sql.all<Replacement>('SELECT * FROM sponsor_replacements WHERE operation_id=?', op.id)
    if (saved !== undefined) return saved
    if (this.account?.address.toLowerCase() !== op.relay.toLowerCase())
      throw new Error('the saved sponsorship relay is unavailable for nonce recovery')
    const original = parseTransaction(op.raw_tx as Hex),
      fees = await sdk.transactionFees(this.ctx.publicClient)
    // Bump both fee fields above the signed redemption, so a mempool can replace an already accepted original.
    const maxPriorityFeePerGas = max(bump(original.maxPriorityFeePerGas ?? 0n), fees.maxPriorityFeePerGas)
    const required = max(bump(original.maxFeePerGas ?? 0n), fees.baseFeePerGas + maxPriorityFeePerGas)
    const affordable = BigInt(op.reserved_cost) / 100_000n
    const preferred = max(required, fees.maxFeePerGas)
    // The cancellation replaces this operation's reservation. If fee conditions outgrow it, recover
    // the nonce anyway; the mined receipt (including any overshoot) charges that day's ledger exactly once.
    const maxFeePerGas = affordable >= required ? (preferred < affordable ? preferred : affordable) : required
    // Like a first send, the floor counts what the cancellation will most likely pay, not its cap.
    if (
      (await this.ctx.publicClient.getBalance({ address: this.account.address })) <
      sponsorRelayFloor(this.ctx.deployment.network) +
        100_000n * min(maxFeePerGas, fees.baseFeePerGas + maxPriorityFeePerGas)
    )
      throw new Error('the sponsorship relay is below its balance floor for nonce recovery')
    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: this.ctx.deployment.chainId,
      nonce: op.nonce,
      to: this.account.address,
      data: '0x',
      value: 0n,
      gas: 100_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    const hash = keccak256(raw)
    this.sql.run(
      "INSERT INTO sponsor_replacements (operation_id,raw_tx,tx_hash,nonce,status) VALUES (?,?,?,?,'pending')",
      op.id,
      raw,
      hash,
      op.nonce,
    )
    return { operation_id: op.id, raw_tx: raw, tx_hash: hash, nonce: op.nonce, status: 'pending' }
  }
  /** Caller holds the relay nonce queue for sends; polling sets broadcast=false and never signs or sends. */
  async resume(op: SponsorOperation, broadcast = true): Promise<SponsorResult> {
    if (op.status === 'pending') {
      let original = await this.#receipt(op.tx_hash as Hex)
      let replacement = this.sql.all<Replacement>('SELECT * FROM sponsor_replacements WHERE operation_id=?', op.id)[0]
      let cancelled = replacement === undefined ? undefined : await this.#receipt(replacement.tx_hash)
      if (original === undefined && cancelled === undefined) {
        const latest = await this.ctx.publicClient.getTransactionCount({
          address: getAddress(op.relay),
          blockTag: 'latest',
        })
        if (latest > op.nonce) {
          // Re-read after the nonce observation, since either transaction could have mined during the first read.
          original = await this.#receipt(op.tx_hash as Hex)
          cancelled = replacement === undefined ? undefined : await this.#receipt(replacement.tx_hash)
          if (original === undefined && cancelled === undefined) {
            this.#drop(op)
            if (replacement !== undefined)
              this.sql.run("UPDATE sponsor_replacements SET status='dropped' WHERE operation_id=?", op.id)
          }
        } else if (broadcast) {
          const authority = await this.#authority(op)
          const live = replacement === undefined && authority.live
          // A changed grant/counter must never cause a fresh redemption of saved calls. Once a replacement is
          // persisted, recovery stays on that path even if a new grant is subsequently prepared.
          if (live && authority.countersUnchanged) {
            try {
              await this.ctx.publicClient.sendRawTransaction({ serializedTransaction: op.raw_tx as Hex })
            } catch {
              /* Reconcile saved hash. */
            }
            original = await this.ctx.publicClient
              .waitForTransactionReceipt({ hash: op.tx_hash as Hex, timeout: 20_000 })
              .catch(() => undefined)
          } else if (!live || !authority.countersUnchanged) {
            replacement = await this.#replacement(op)
            try {
              await this.ctx.publicClient.sendRawTransaction({ serializedTransaction: replacement.raw_tx })
            } catch {
              /* Original may have won the nonce. */
            }
            // Check the original first; an already-broadcast redemption can beat the cancellation.
            original = await this.#receipt(op.tx_hash as Hex)
            if (original === undefined)
              cancelled = await this.ctx.publicClient
                .waitForTransactionReceipt({ hash: replacement.tx_hash, timeout: 20_000 })
                .catch(() => undefined)
            original ??= await this.#receipt(op.tx_hash as Hex)
          }
        }
      }
      if (original !== undefined) {
        await this.#charge('sponsor_operations', op, original, original.status === 'success' ? 'confirmed' : 'reverted')
        if (replacement !== undefined)
          this.sql.run("UPDATE sponsor_replacements SET status='dropped' WHERE operation_id=?", op.id)
      } else if (cancelled !== undefined) {
        await this.#charge('sponsor_replacements', op, cancelled, cancelled.status)
        this.#drop(op)
      }
    }
    const [row] = this.sql.all<{ status: SponsorResult['status'] }>(
      'SELECT status FROM sponsor_operations WHERE id=?',
      op.id,
    )
    return {
      operationId: op.id,
      txHash: op.tx_hash as Hex,
      status: row!.status,
      callsUsed: Number(await callsMade(this.ctx, op.delegation_hash as Hex)),
    }
  }
  async checkPending() {
    for (const op of this.sql.all<SponsorOperation>("SELECT * FROM sponsor_operations WHERE status='pending'")) {
      if ((await this.resume(op)).status === 'pending')
        throw new Error('an earlier sponsored transaction is still pending; reconcile its saved operation')
    }
  }
}
