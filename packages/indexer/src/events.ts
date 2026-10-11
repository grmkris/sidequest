/**
 * Decoding: a raw log becomes a job or protocol event with JSON-safe arguments. Each pair keeps its own ABI;
 * job-less events (including stake and epoch claims) follow the same atomic checkpoint as job events.
 */
import * as sdk from '@sidequest/sdk'
import { type Abi, type Address, type Hex, decodeEventLog } from 'viem'

export interface RawLog {
  readonly block_number: number
  readonly log_index: number
  readonly transaction_hash: Hex
  readonly address: Address
  readonly topic0?: Hex | null
  readonly topic1?: Hex | null
  readonly topic2?: Hex | null
  readonly topic3?: Hex | null
  readonly data: Hex
}

export interface IndexedEvent {
  readonly chainId: number
  readonly contract: string
  readonly block: number
  readonly logIndex: number
  readonly txHash: string
  /** Null for protocol events emitted by the vault, fee schedule, reserve or distributor. */
  readonly jobId: string | null
  readonly name: string
  readonly args: Record<string, JsonValue>
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Role = 'core' | 'holding' | 'evaluator' | 'vault' | 'feeSchedule' | 'miningReserve' | 'distributor'

/** Which ABI decodes which address, and which stack a Holding or evaluator belongs to. */
export interface Contracts {
  readonly chainId: number
  readonly core: string
  readonly roles: ReadonlyMap<string, { role: Role; stack: string | null; kind: sdk.StackKind | null }>
}

export function contractsOf(network: sdk.Network): Contracts {
  return contractsFromDeployment(sdk.deployment(network))
}

/** Use an archived deployment when replaying historical logs offline. */
export function contractsFromDeployment(d: sdk.Deployment): Contracts {
  const roles = new Map<string, { role: Role; stack: string | null; kind: sdk.StackKind | null }>([
    [d.core.toLowerCase(), { role: 'core', stack: null, kind: null }],
  ])
  for (const [name, s] of sdk.allStacks(d)) {
    roles.set(s.holding.toLowerCase(), { role: 'holding', stack: name, kind: s.kind })
    roles.set(s.evaluator.toLowerCase(), { role: 'evaluator', stack: name, kind: s.kind })
  }
  if (d.sidequest !== null) {
    roles.set(d.sidequest.vault.toLowerCase(), { role: 'vault', stack: null, kind: 'sidequest-v1' })
    roles.set(d.sidequest.feeSchedule.toLowerCase(), { role: 'feeSchedule', stack: null, kind: 'sidequest-v1' })
    roles.set(d.sidequest.miningReserve.toLowerCase(), { role: 'miningReserve', stack: null, kind: 'sidequest-v1' })
    roles.set(d.sidequest.distributor.toLowerCase(), { role: 'distributor', stack: null, kind: 'sidequest-v1' })
  }
  return { chainId: d.chainId, core: d.core.toLowerCase(), roles }
}

const v1Abis: Partial<Record<Role, Abi>> = {
  core: sdk.coreAbi as Abi,
  holding: sdk.sidequestHoldingAbi as Abi,
  evaluator: sdk.sidequestEvaluatorAbi as Abi,
  vault: sdk.stakeVaultAbi as Abi,
  feeSchedule: sdk.feeScheduleAbi as Abi,
  miningReserve: sdk.miningReserveAbi as Abi,
  distributor: sdk.epochDistributorAbi as Abi,
}

const jsonSafe = (v: unknown): JsonValue => {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, jsonSafe(value)]))
  return String(v)
}

/** A decoded job or protocol event, or undefined for an unknown contract or undecodable log. */
export function decode(contracts: Contracts, log: RawLog): IndexedEvent | undefined {
  const who = contracts.roles.get(log.address.toLowerCase())
  if (who === undefined) return undefined
  const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((t): t is Hex => typeof t === 'string')
  if (topics.length === 0) return undefined
  let decoded: { eventName: string; args: unknown }
  try {
    const abi = v1Abis[who.role]
    if (abi === undefined) return undefined
    decoded = decodeEventLog({ abi, data: log.data, topics: topics as [Hex, ...Hex[]] }) as typeof decoded
  } catch {
    return undefined
  }
  const raw = (decoded.args ?? {}) as Record<string, unknown>
  const args: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(raw)) args[k] = jsonSafe(v)
  return {
    chainId: contracts.chainId,
    contract: log.address.toLowerCase(),
    block: log.block_number,
    logIndex: log.log_index,
    txHash: log.transaction_hash,
    jobId: raw.jobId === undefined ? null : String(raw.jobId),
    name: decoded.eventName,
    args,
  }
}
