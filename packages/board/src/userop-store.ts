/** The durable journal in the existing management object. Signed bytes precede every send. */
import * as sdk from '@sidequest/sdk'
import type { Address, Hex } from 'viem'
import type { Sql } from './store.ts'

export type UserOpStatus =
  | 'building'
  | 'built'
  | 'signed'
  | 'pending'
  | 'uncertain'
  | 'spent'
  | 'dropped'
  | 'confirmed'
  | 'reverted'
  | 'failed'
export interface UserOpRow {
  id: string
  agent_id: string
  sender: Address
  nonce_key: string
  request_json: string
  status: UserOpStatus
  built_json: string | null
  authorization_json: string | null
  userop_hash: Hex | null
  tx_hash: Hex | null
  actual_gas_cost: string | null
  from_block: string
  created_at: number
  updated_at: number
}
export interface UserOpAttempt {
  operation_id: string
  attempt: number
  built_json: string
  signature: Hex
  userop_hash: Hex
  sent_at: number | null
  outcome: 'signed' | 'pending' | 'uncertain' | 'dropped' | 'confirmed' | 'reverted' | 'refused'
}

/** Additive DO migration, alongside the board's CREATE IF NOT EXISTS migrations. */
export function migrateUserOpSchema(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS userop_operations (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, sender TEXT NOT NULL, nonce_key TEXT NOT NULL,
    request_json TEXT NOT NULL, status TEXT NOT NULL, built_json TEXT, authorization_json TEXT,
    userop_hash TEXT, tx_hash TEXT, actual_gas_cost TEXT, from_block TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(sender,nonce_key)
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS userop_attempts (
    operation_id TEXT NOT NULL, attempt INTEGER NOT NULL, built_json TEXT NOT NULL,
    signature TEXT NOT NULL, userop_hash TEXT NOT NULL, sent_at INTEGER, outcome TEXT NOT NULL,
    PRIMARY KEY(operation_id,attempt), UNIQUE(operation_id,userop_hash)
  )`)
}

interface FrozenBuild {
  op: ReturnType<typeof sdk.toBundlerJson>
  authorization?: sdk.SignedAuthorization
  entryPoint: Address
  chainId: number
  maxCost: string
  userOpHash: Hex
}

function freezeUserOp(built: sdk.BuiltUserOp): string {
  return JSON.stringify({ ...built, op: sdk.toBundlerJson(built.op), maxCost: built.maxCost.toString() })
}

export function thawUserOp(json: string): sdk.BuiltUserOp {
  // SAFETY: only freezeUserOp writes built_json; quantities are serialized as hex strings.
  const frozen = JSON.parse(json) as FrozenBuild
  const { op } = frozen
  const paymaster = op.paymaster
  // SAFETY: the frozen representation is produced by freezeUserOp and contains only the v0.7 JSON quantities.
  const thawedOp: sdk.UserOperation = {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    callData: op.callData,
    callGasLimit: BigInt(op.callGasLimit),
    verificationGasLimit: BigInt(op.verificationGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    signature: op.signature,
    ...(paymaster === undefined
      ? {}
      : {
          paymaster,
          paymasterVerificationGasLimit: BigInt(op.paymasterVerificationGasLimit!),
          paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit!),
          paymasterData: op.paymasterData,
        }),
  }
  return {
    ...frozen,
    maxCost: BigInt(frozen.maxCost),
    op: thawedOp,
  }
}

export class UserOpStore {
  constructor(
    readonly sql: Sql,
    readonly now: () => number,
  ) {
    migrateUserOpSchema(sql)
  }

  operation(id: string): UserOpRow | undefined {
    return this.sql.all<UserOpRow>('SELECT * FROM userop_operations WHERE id=?', id)[0]
  }

  require(id: string): UserOpRow {
    const row = this.operation(id)
    if (row === undefined) throw new Error('User operation not found')
    return row
  }

  begin(input: { id: string; agentId: string; sender: Address; request: string; fromBlock: bigint }): UserOpRow {
    const key = sdk.nonceKey(input.id).toString()
    this.sql.run(
      `INSERT OR IGNORE INTO userop_operations
      (id,agent_id,sender,nonce_key,request_json,status,from_block,created_at,updated_at)
      VALUES (?,?,?,?,?,'building',?,?,?)`,
      input.id,
      input.agentId,
      input.sender.toLowerCase(),
      key,
      input.request,
      input.fromBlock.toString(),
      this.now(),
      this.now(),
    )
    const row = this.require(input.id)
    if (
      row.agent_id !== input.agentId ||
      row.sender !== input.sender.toLowerCase() ||
      row.request_json !== input.request
    )
      throw new Error('User operation identity cannot change')
    return row
  }

  built(id: string, built: sdk.BuiltUserOp): UserOpRow {
    const row = this.require(id)
    const json = freezeUserOp(built)
    if (row.status === 'built' && row.built_json === json) return row
    if (!['building', 'dropped'].includes(row.status)) throw new Error('Reconcile before rebuilding a user operation')
    if (built.op.sender.toLowerCase() !== row.sender || built.op.nonce !== sdk.laneNonce(BigInt(row.nonce_key)))
      throw new Error('Built user operation changed its sender or lane')
    this.sql.run(
      `UPDATE userop_operations SET status='built',built_json=?,authorization_json=?,userop_hash=?,updated_at=? WHERE id=?`,
      json,
      built.authorization === undefined ? null : JSON.stringify(built.authorization),
      built.userOpHash,
      this.now(),
      id,
    )
    return this.require(id)
  }

  signed(id: string, signature: Hex): UserOpAttempt {
    return this.#atomic(() => {
      const row = this.require(id)
      const latest = this.attempts(id).at(-1)
      if (row.status === 'signed' && latest?.signature === signature) return latest
      if (row.status !== 'built' || row.built_json === null) throw new Error('Build before signing a user operation')
      const built = thawUserOp(row.built_json)
      const signed = { ...built, op: { ...built.op, signature } }
      const attempt = (latest?.attempt ?? 0) + 1
      if (latest?.userop_hash === built.userOpHash) {
        if (latest.signature !== signature) throw new Error('Signature for the same user operation cannot change')
        this.sql.run(
          "UPDATE userop_attempts SET outcome='signed',sent_at=NULL WHERE operation_id=? AND attempt=?",
          id,
          latest.attempt,
        )
      } else
        this.sql.run(
          'INSERT INTO userop_attempts VALUES (?,?,?,?,?,NULL,?)',
          id,
          attempt,
          freezeUserOp(signed),
          signature,
          built.userOpHash,
          'signed',
        )
      this.sql.run(
        "UPDATE userop_operations SET status='signed',built_json=?,userop_hash=?,updated_at=? WHERE id=?",
        freezeUserOp(signed),
        built.userOpHash,
        this.now(),
        id,
      )
      return this.attempts(id).at(-1)!
    })
  }

  attempts(id: string): UserOpAttempt[] {
    return this.sql.all<UserOpAttempt>('SELECT * FROM userop_attempts WHERE operation_id=? ORDER BY attempt', id)
  }

  outcome(id: string, status: UserOpStatus, outcome: UserOpAttempt['outcome'], sent = false): UserOpRow {
    return this.#atomic(() => {
      const latest = this.attempts(id).at(-1)
      if (latest === undefined) throw new Error('No signed user operation attempt')
      if (['confirmed', 'reverted', 'failed', 'spent'].includes(this.require(id).status))
        throw new Error('User operation is terminal')
      this.sql.run(
        'UPDATE userop_attempts SET outcome=?,sent_at=COALESCE(sent_at,?) WHERE operation_id=? AND attempt=?',
        outcome,
        sent ? this.now() : null,
        id,
        latest.attempt,
      )
      this.sql.run('UPDATE userop_operations SET status=?,updated_at=? WHERE id=?', status, this.now(), id)
      return this.require(id)
    })
  }

  waiting(id: string): UserOpRow {
    const row = this.require(id)
    if (row.status === 'confirmed' || row.status === 'reverted' || row.status === 'spent') return row
    this.sql.run("UPDATE userop_operations SET status='pending',updated_at=? WHERE id=?", this.now(), id)
    return this.require(id)
  }

  /** A spent lane remains spent across provider drift and restarts, until its receipt/event is found. */
  spent(id: string): UserOpRow {
    const row = this.require(id)
    if (row.status === 'confirmed' || row.status === 'reverted') return row
    this.sql.run("UPDATE userop_operations SET status='spent',updated_at=? WHERE id=?", this.now(), id)
    return this.require(id)
  }

  finish(id: string, hash: Hex, receipt: sdk.UserOpReceipt): UserOpRow {
    return this.#atomic(() => {
      const row = this.require(id)
      const status = receipt.status === 'success' ? 'confirmed' : 'reverted'
      if (row.tx_hash !== null) {
        if (row.tx_hash !== receipt.txHash || row.status !== status || row.userop_hash !== hash)
          throw new Error('User operation receipt cannot change')
        return row
      }
      this.sql.run('UPDATE userop_attempts SET outcome=? WHERE operation_id=? AND userop_hash=?', status, id, hash)
      this.sql.run(
        'UPDATE userop_operations SET status=?,userop_hash=?,tx_hash=?,actual_gas_cost=?,updated_at=? WHERE id=?',
        status,
        hash,
        receipt.txHash,
        receipt.actualGasCost.toString(),
        this.now(),
        id,
      )
      return this.require(id)
    })
  }

  #atomic<T>(write: () => T): T {
    if (this.sql.atomic === undefined) throw new Error('User operation journal requires atomic storage')
    return this.sql.atomic(write)
  }
}
