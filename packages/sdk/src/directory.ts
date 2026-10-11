import { type Address, type Hex, encodeFunctionData, hashTypedData, keccak256, stringToHex, zeroAddress } from 'viem'
import { identityAbi } from './abi/index.ts'

export type DirectoryKind = 'Enrollment' | 'Heartbeat' | 'ServiceAd' | 'RevokeAd'
export type Availability = 'available' | 'busy' | 'idle' | 'draining'

export interface DirectoryProfile {
  name: string
  description: string
  services: string[]
}

export interface ServiceAdvertisement {
  serviceId: string
  name: string
  description: string
  inputs: string
  outputs: string
  turnaroundSeconds: number
  price: { model: 'fixed' | 'per-unit' | 'quote' | 'free/testnet'; amountBaseUnits: string; token: Address }
}

export interface DirectoryEnvelope {
  version: 1
  kind: DirectoryKind
  chainId: number
  identityRegistry: Address
  audience: string
  agentId: string
  wallet: Address
  generation: number
  nonce: number
  issuedAt: number
  expiresAt: number
  payload: Record<string, unknown>
}

export interface DirectoryAgent {
  chainId: number
  identityRegistry: Address
  agentId: string
  wallet: Address
  profile: DirectoryProfile
  profileSource: 'operator-supplied'
  agentURI: string
  enrolled: boolean
  ownership: 'verified' | 'unknown' | 'changed'
  presence: {
    freshness: 'fresh' | 'stale' | 'unknown'
    state: Availability | null
    accepting: boolean
    lastSeenBucket: number | null
  }
  ads: Array<ServiceAdvertisement & { adHash: Hex; expiresAt: number }>
  /** A Sidequest-hosted agent's last MCP call, to five minutes; absent for self-run agents. */
  activity?: { lastMcpCallAt: number }
  observedAt: number
  projectionAt: number
  revision: number
}

export function canonicalDirectoryJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalDirectoryJson).join(',')}]`
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalDirectoryJson(object[key])}`)
      .join(',')}}`
  }
  throw new Error('directory records must be bounded JSON with safe integer numbers')
}

export const directoryHash = (value: unknown): Hex => keccak256(stringToHex(canonicalDirectoryJson(value)))

/** Every directory record kind signs these fields (EIP-712), with the payload as its canonical hash. */
export const directoryRecordFields = [
  { name: 'version', type: 'uint256' },
  { name: 'identityRegistry', type: 'address' },
  { name: 'audience', type: 'string' },
  { name: 'agentId', type: 'uint256' },
  { name: 'wallet', type: 'address' },
  { name: 'generation', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiresAt', type: 'uint256' },
  { name: 'payloadHash', type: 'bytes32' },
] as const
const RECORD_TYPES = {
  Enrollment: directoryRecordFields,
  Heartbeat: directoryRecordFields,
  ServiceAd: directoryRecordFields,
  RevokeAd: directoryRecordFields,
} as const

/** The directory's EIP-712 domain fields: no contract verifies them, so the audience is bound by `salt`. */
export const directoryDomainFields = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
] as const

/** A directory record's domain name: presence (enrollment, heartbeat) or service ads. */
export const directoryDomainName = (kind: DirectoryKind) =>
  kind === 'ServiceAd' || kind === 'RevokeAd' ? 'SidequestServiceAd' : 'SidequestPresence'

export function directoryTypedData(record: DirectoryEnvelope) {
  return {
    domain: {
      name: directoryDomainName(record.kind),
      version: '1',
      chainId: record.chainId,
      verifyingContract: zeroAddress,
      salt: keccak256(stringToHex(record.audience)),
    },
    types: RECORD_TYPES,
    primaryType: record.kind,
    message: {
      version: BigInt(record.version),
      identityRegistry: record.identityRegistry,
      audience: record.audience,
      agentId: BigInt(record.agentId),
      wallet: record.wallet,
      generation: BigInt(record.generation),
      nonce: BigInt(record.nonce),
      issuedAt: BigInt(record.issuedAt),
      expiresAt: BigInt(record.expiresAt),
      payloadHash: directoryHash(record.payload),
    },
  } as const
}

export const directoryRecordHash = (record: DirectoryEnvelope): Hex => hashTypedData(directoryTypedData(record))

/**
 * A directory record as `eth_signTypedData_v4` JSON for a hosted signer: the record's own type only, the domain with
 * its `salt`, and integers as decimal strings. It hashes to `directoryRecordHash`.
 */
export function directoryTypedDataJson(record: DirectoryEnvelope): string {
  const typed = directoryTypedData(record)
  return JSON.stringify(
    {
      types: { EIP712Domain: directoryDomainFields, [record.kind]: directoryRecordFields },
      primaryType: typed.primaryType,
      domain: typed.domain,
      message: typed.message,
    },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
}

export function directoryProfileURI(profile: DirectoryProfile): string {
  const file = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: profile.name,
    description: profile.description,
    services: [],
    active: true,
  }
  return `data:application/json,${encodeURIComponent(JSON.stringify(file))}`
}

export function prepareDirectoryIdentity(identityRegistry: Address, profile: DirectoryProfile, agentId?: string) {
  const agentURI = directoryProfileURI(profile)
  const data =
    agentId === undefined
      ? encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [agentURI] })
      : encodeFunctionData({ abi: identityAbi, functionName: 'setAgentURI', args: [BigInt(agentId), agentURI] })
  return { transaction: { to: identityRegistry, data, value: '0' }, agentURI, requiresWalletConfirmation: true }
}
