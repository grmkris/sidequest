import {
  type Availability,
  type DirectoryAgent,
  type DirectoryEnvelope,
  type DirectoryKind,
  type DirectoryProfile,
  type ServiceAdvertisement,
  canonicalDirectoryJson,
  directoryRecordHash,
  directoryTypedData,
} from '@sidequest/sdk'
import { type Address, type Hex, getAddress, isAddress, maxUint256, zeroAddress } from 'viem'
import type { Sql } from './store.ts'

export class DirectoryError extends Error {
  constructor(
    readonly code: 'invalid' | 'forbidden' | 'conflict' | 'chain' | 'not-found' | 'rate-limited',
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

export interface DirectoryDeps {
  sql: Sql
  chainId: number
  identityRegistry: Address
  audience: string
  agentId: string
  now: () => number
  readIdentity: (agentId: string) => Promise<{ wallet: Address; agentURI: string }>
  verify: (address: Address, record: DirectoryEnvelope, signature: Hex) => Promise<boolean>
}

interface Accepted {
  nonce: number
  hash: Hex
}

interface DirectoryState {
  revision: number
  generation: number
  enrolled: boolean
  wallet: Address
  profile: DirectoryProfile
  agentURI: string
  delegate: Address
  adDelegate: boolean
  grantExpiresAt: number
  ownership: DirectoryAgent['ownership']
  checkedAt: number
  heartbeat: { state: Availability; capacity: number; receivedAt: number; expiresAt: number; sessionId: string } | null
  ads: Record<string, { ad: ServiceAdvertisement; hash: Hex; expiresAt: number; revoked: boolean }>
  accepted: Partial<Record<DirectoryKind, Accepted>>
  beats: number[]
  mutations: number[]
  projectionAt: number
}

const initial = (): DirectoryState => ({
  revision: 0,
  generation: 0,
  enrolled: false,
  wallet: zeroAddress,
  profile: { name: '', description: '', services: [] },
  agentURI: '',
  delegate: zeroAddress,
  adDelegate: false,
  grantExpiresAt: 0,
  ownership: 'unknown',
  checkedAt: 0,
  heartbeat: null,
  ads: {},
  accepted: {},
  beats: [],
  mutations: [],
  projectionAt: 0,
})
const invalid = (message: string): never => {
  throw new DirectoryError('invalid', message)
}
const forbidden = (message: string): never => {
  throw new DirectoryError('forbidden', message)
}

export function directoryAgentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,77}$/.test(value) || BigInt(value) > maxUint256)
    return invalid('agentId must be a positive uint256 decimal string')
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('expected a JSON object')
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid('unknown directory field')
}

function text(value: unknown, label: string, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && value.trim().length === 0) ||
    [...value].some((character) => character.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(character))
  )
    return invalid(`${label} must be bounded plaintext`)
  return value
}

function integer(value: unknown, label: string, max: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid(`${label} must be an integer between ${min} and ${max}`)
  return value
}

function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value)) return invalid('expected an Ethereum address')
  return getAddress(value)
}

export function validateDirectoryProfile(value: unknown): DirectoryProfile {
  const profile = object(value)
  exact(profile, ['name', 'description', 'services'])
  if (!Array.isArray(profile.services) || profile.services.length > 10)
    return invalid('services must be at most ten plaintext labels')
  return {
    name: text(profile.name, 'name', 80),
    description: text(profile.description, 'description', 1200, true),
    services: profile.services.map((service) => text(service, 'service', 100)),
  }
}

export function validateAdvertisement(value: unknown): ServiceAdvertisement {
  const ad = object(value)
  exact(ad, ['serviceId', 'name', 'description', 'inputs', 'outputs', 'turnaroundSeconds', 'price'])
  const serviceId = text(ad.serviceId, 'serviceId', 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(serviceId)) return invalid('serviceId must be a lowercase slug')
  const price = object(ad.price)
  exact(price, ['model', 'amountBaseUnits', 'token'])
  if (!['fixed', 'per-unit', 'quote', 'free/testnet'].includes(String(price.model)))
    return invalid('unknown price model')
  const amount = text(price.amountBaseUnits, 'amountBaseUnits', 78)
  if (!/^(0|[1-9]\d*)$/.test(amount) || BigInt(amount) > maxUint256)
    return invalid('amountBaseUnits must be a uint256 decimal string')
  return {
    serviceId,
    name: text(ad.name, 'name', 100),
    description: text(ad.description, 'description', 2000, true),
    inputs: text(ad.inputs, 'inputs', 2000),
    outputs: text(ad.outputs, 'outputs', 2000),
    turnaroundSeconds: integer(ad.turnaroundSeconds, 'turnaroundSeconds', 30 * 86400, 1),
    price: {
      model: price.model as ServiceAdvertisement['price']['model'],
      amountBaseUnits: amount,
      token: address(price.token),
    },
  }
}

export class DirectoryService {
  constructor(readonly deps: DirectoryDeps) {
    directoryAgentId(deps.agentId)
    deps.sql.run(
      'CREATE TABLE IF NOT EXISTS directory_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, json TEXT NOT NULL)',
    )
  }

  state(): DirectoryState {
    const [row] = this.deps.sql.all<{ json: string }>('SELECT json FROM directory_state WHERE id = 1')
    if (row === undefined) return initial()
    // SAFETY: this object is written by save; older records predate the mutation bucket.
    const state = JSON.parse(row.json) as DirectoryState
    return { ...state, mutations: state.mutations ?? [] }
  }

  save(state: DirectoryState, expectedRevision: number): void {
    if (this.state().revision !== expectedRevision)
      throw new DirectoryError('conflict', 'directory changed during verification; prepare again')
    state.revision = expectedRevision + 1
    this.deps.sql.run(
      'INSERT INTO directory_state (id, revision, json) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, json = excluded.json',
      state.revision,
      JSON.stringify(state),
    )
  }

  async identity(state: DirectoryState) {
    try {
      const result = await this.deps.readIdentity(this.deps.agentId)
      if (result.wallet === zeroAddress) throw new Error('agent has no wallet')
      return {
        wallet: getAddress(result.wallet),
        agentURI: result.agentURI,
      }
    } catch {
      state.ownership = 'unknown'
      state.checkedAt = this.deps.now()
      if (state.revision > 0) this.save(state, state.revision)
      throw new DirectoryError('chain', 'identity registry unavailable; wallet proof is unknown')
    }
  }

  invalidate(state: DirectoryState, wallet: Address): void {
    if (state.wallet === zeroAddress || state.wallet.toLowerCase() === wallet.toLowerCase()) return
    state.generation += 1
    state.delegate = zeroAddress
    state.grantExpiresAt = 0
    state.heartbeat = null
    for (const ad of Object.values(state.ads)) ad.revoked = true
    state.enrolled = false
    state.ownership = 'changed'
    state.checkedAt = this.deps.now()
    this.save(state, state.revision)
  }

  validatePayload(kind: DirectoryKind, value: unknown): Record<string, unknown> {
    const payload = object(value)
    if (kind === 'Enrollment') {
      exact(payload, ['profile', 'delegate', 'adDelegate', 'grantExpiresAt', 'enrolled'])
      if (typeof payload.adDelegate !== 'boolean' || typeof payload.enrolled !== 'boolean')
        invalid('grant scopes and opt-in must be boolean')
      return {
        profile: validateDirectoryProfile(payload.profile),
        delegate: address(payload.delegate),
        adDelegate: payload.adDelegate,
        grantExpiresAt: integer(payload.grantExpiresAt, 'grantExpiresAt', Number.MAX_SAFE_INTEGER),
        enrolled: payload.enrolled,
      }
    }
    if (kind === 'Heartbeat') {
      exact(payload, ['state', 'capacity', 'sessionId', 'capabilitiesHash', 'endpointHash'])
      if (!['available', 'busy', 'idle', 'draining'].includes(String(payload.state)))
        invalid('unknown availability state')
      for (const key of ['capabilitiesHash', 'endpointHash'])
        if (typeof payload[key] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(payload[key] as string))
          invalid(`${key} must be bytes32`)
      return {
        state: payload.state,
        capacity: integer(payload.capacity, 'capacity', 100),
        sessionId: text(payload.sessionId, 'sessionId', 80),
        capabilitiesHash: payload.capabilitiesHash,
        endpointHash: payload.endpointHash,
      }
    }
    if (kind === 'ServiceAd') return { ...validateAdvertisement(payload) }
    exact(payload, ['serviceId'])
    const serviceId = text(payload.serviceId, 'serviceId', 64)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(serviceId)) invalid('serviceId must be a lowercase slug')
    return { serviceId }
  }

  async prepare(kind: DirectoryKind, payload: unknown, expiresAt?: number): Promise<DirectoryEnvelope> {
    const checkedPayload = this.validatePayload(kind, payload)
    const state = this.state()
    const identity = await this.identity(state)
    this.invalidate(state, identity.wallet)
    const current = this.state()
    const now = this.deps.now()
    const expiry =
      expiresAt ?? now + (kind === 'Heartbeat' ? 60 : kind === 'Enrollment' || kind === 'RevokeAd' ? 300 : 86400)
    const record: DirectoryEnvelope = {
      version: 1,
      kind,
      chainId: this.deps.chainId,
      identityRegistry: this.deps.identityRegistry,
      audience: this.deps.audience,
      agentId: this.deps.agentId,
      wallet: identity.wallet,
      generation: current.generation + (kind === 'Enrollment' ? 1 : 0),
      nonce: (current.accepted[kind]?.nonce ?? 0) + 1,
      issuedAt: now,
      expiresAt: expiry,
      payload: checkedPayload,
    }
    this.validateRecord(record)
    return record
  }

  validateRecord(input: unknown): DirectoryEnvelope {
    const record = object(input)
    exact(record, [
      'version',
      'kind',
      'chainId',
      'identityRegistry',
      'audience',
      'agentId',
      'wallet',
      'generation',
      'nonce',
      'issuedAt',
      'expiresAt',
      'payload',
    ])
    if (record.version !== 1 || !['Enrollment', 'Heartbeat', 'ServiceAd', 'RevokeAd'].includes(String(record.kind)))
      invalid('unsupported directory record')
    const kind = record.kind as DirectoryKind
    const bytes = new TextEncoder().encode(canonicalDirectoryJson(record)).length
    if (bytes > (kind === 'Heartbeat' ? 4096 : 32768)) invalid('directory record is too large')
    if (
      record.chainId !== this.deps.chainId ||
      record.identityRegistry !== this.deps.identityRegistry ||
      record.audience !== this.deps.audience ||
      record.agentId !== this.deps.agentId
    )
      forbidden('wrong chain, registry, audience, or agent')
    integer(record.generation, 'generation', Number.MAX_SAFE_INTEGER, 1)
    integer(record.nonce, 'nonce', Number.MAX_SAFE_INTEGER, 1)
    integer(record.issuedAt, 'issuedAt', Number.MAX_SAFE_INTEGER)
    integer(record.expiresAt, 'expiresAt', Number.MAX_SAFE_INTEGER)
    address(record.wallet)
    const payload = this.validatePayload(kind, record.payload)
    if (canonicalDirectoryJson(payload) !== canonicalDirectoryJson(record.payload))
      invalid('directory payload must use normalized addresses and fields')
    return record as unknown as DirectoryEnvelope
  }

  async submit(
    input: unknown,
    signature: unknown,
  ): Promise<{ agent: DirectoryAgent; projection: DirectoryAgent | null; idempotent: boolean }> {
    const record = this.validateRecord(input)
    if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(signature))
      invalid('signature must be bounded hex')
    const before = this.state()
    const identity = await this.identity(before)
    this.invalidate(before, identity.wallet)
    if (identity.wallet.toLowerCase() !== record.wallet.toLowerCase())
      forbidden('signature wallet is not the current ERC-8004 agent wallet')
    const state = this.state()
    const hash = directoryRecordHash(record)
    const previous = state.accepted[record.kind]
    const expectedGeneration = state.generation + (record.kind === 'Enrollment' ? 1 : 0)
    if (previous?.hash === hash && previous.nonce === record.nonce && state.generation === record.generation) {
      return { agent: this.publicView(state), projection: this.publicView(state), idempotent: true }
    }
    if (record.generation !== expectedGeneration || (previous !== undefined && record.nonce <= previous.nonce))
      throw new DirectoryError('conflict', 'stale generation or replayed nonce; prepare a new record')
    const now = this.deps.now()
    const maxExpiry =
      record.kind === 'Heartbeat' ? 60 : record.kind === 'Enrollment' || record.kind === 'RevokeAd' ? 300 : 86400
    if (Math.abs(record.issuedAt - now) > 10 || record.expiresAt <= now || record.expiresAt > now + maxExpiry)
      forbidden('record is expired or outside its server-time validity window')
    let signer = identity.wallet
    if (record.kind !== 'Enrollment') {
      if (!state.enrolled || state.ownership === 'changed')
        forbidden('enroll the current wallet before publishing presence or ads')
      const delegateValid =
        state.delegate !== zeroAddress &&
        state.grantExpiresAt > now &&
        (record.kind === 'Heartbeat' || state.adDelegate)
      if (delegateValid) signer = state.delegate
    }
    let verified = false
    try {
      verified = await this.deps.verify(signer, record, signature as Hex)
    } catch {
      throw new DirectoryError('chain', 'signature verifier unavailable')
    }
    if (!verified && signer !== identity.wallet) {
      try {
        verified = await this.deps.verify(identity.wallet, record, signature as Hex)
      } catch {
        throw new DirectoryError('chain', 'signature verifier unavailable')
      }
      if (verified) signer = identity.wallet
    }
    if (!verified) forbidden('invalid directory signature')
    if (this.state().revision !== state.revision)
      throw new DirectoryError('conflict', 'directory changed during signature verification')
    const latestState = this.state()
    const latestIdentity = await this.identity(latestState)
    if (latestIdentity.wallet.toLowerCase() !== identity.wallet.toLowerCase()) {
      this.invalidate(latestState, latestIdentity.wallet)
      forbidden('current ERC-8004 agent wallet changed during verification')
    }
    if (record.expiresAt <= this.deps.now() || Math.abs(record.issuedAt - this.deps.now()) > 10)
      forbidden('record expired during verification; prepare again')
    if (record.kind !== 'Heartbeat') {
      state.mutations = state.mutations.filter((at) => at > now - 60)
      if (state.mutations.length >= 60)
        throw new DirectoryError('rate-limited', 'directory mutation limit reached', state.mutations[0]! + 60 - now)
    }
    const projectedState = state.heartbeat?.state
    state.wallet = identity.wallet
    state.agentURI = identity.agentURI
    state.checkedAt = now
    state.ownership = 'verified'
    state.accepted[record.kind] = { nonce: record.nonce, hash }
    if (record.kind === 'Enrollment') {
      const payload = record.payload
      const grantExpiry = payload.grantExpiresAt as number
      if (
        (payload.delegate !== zeroAddress && (grantExpiry <= now || grantExpiry > now + 86400)) ||
        (payload.delegate === zeroAddress && grantExpiry !== 0)
      )
        forbidden('delegate grant must expire within 24 hours; manual mode has no grant')
      state.profile = payload.profile as DirectoryProfile
      state.enrolled = payload.enrolled as boolean
      state.delegate = payload.delegate as Address
      state.adDelegate = payload.adDelegate as boolean
      state.grantExpiresAt = grantExpiry
      state.generation = record.generation
      state.heartbeat = null
      state.beats = []
      for (const ad of Object.values(state.ads)) ad.revoked = true
    } else if (record.kind === 'Heartbeat') {
      state.beats = state.beats.filter((at) => at > now - 60)
      if (state.beats.length >= 8) forbidden('heartbeat rate limit: six per minute with a two-beat burst')
      if (state.heartbeat !== null && state.heartbeat.sessionId !== record.payload.sessionId)
        forbidden('one process lease per enrollment; re-enroll to change session')
      if (signer !== identity.wallet && record.expiresAt > state.grantExpiresAt)
        forbidden('heartbeat outlives its delegate grant')
      state.beats.push(now)
      state.heartbeat = {
        state: record.payload.state as Availability,
        capacity: record.payload.capacity as number,
        receivedAt: now,
        expiresAt: record.expiresAt,
        sessionId: record.payload.sessionId as string,
      }
    } else if (record.kind === 'ServiceAd') {
      const ad = record.payload as unknown as ServiceAdvertisement
      if (state.ads[ad.serviceId] === undefined && Object.keys(state.ads).length >= 10)
        forbidden('at most ten service IDs per enrolled identity')
      if (signer !== identity.wallet && record.expiresAt > state.grantExpiresAt)
        forbidden('ad outlives its delegate grant')
      state.ads[ad.serviceId] = { ad, hash, expiresAt: record.expiresAt, revoked: false }
    } else {
      const ad = state.ads[String(record.payload.serviceId)]
      if (ad === undefined) throw new DirectoryError('not-found', 'unknown service ID')
      ad.revoked = true
    }
    const project =
      record.kind !== 'Heartbeat' || projectedState !== state.heartbeat?.state || state.projectionAt + 60 <= now
    if (record.kind !== 'Heartbeat') state.mutations.push(now)
    if (project) state.projectionAt = now
    this.save(state, state.revision)
    const agent = this.publicView(state)
    return { agent, projection: project ? agent : null, idempotent: false }
  }

  publicView(state = this.state()): DirectoryAgent {
    const now = this.deps.now()
    const beat = state.heartbeat
    const ownership = state.checkedAt + 30 < now ? 'unknown' : state.ownership
    const freshness = ownership !== 'verified' || beat === null ? 'unknown' : beat.expiresAt > now ? 'fresh' : 'stale'
    return {
      chainId: this.deps.chainId,
      identityRegistry: this.deps.identityRegistry,
      agentId: this.deps.agentId,
      wallet: state.wallet,
      profile: state.profile,
      profileSource: 'operator-supplied',
      agentURI: state.agentURI,
      enrolled: state.enrolled,
      ownership,
      presence: {
        freshness,
        state: beat?.state ?? null,
        accepting: freshness === 'fresh' && beat?.state === 'available' && beat.capacity > 0,
        lastSeenBucket: beat === null ? null : Math.floor(beat.receivedAt / 60) * 60,
      },
      ads: Object.values(state.ads)
        .filter((entry) => !entry.revoked && entry.expiresAt > now && ownership === 'verified')
        .map((entry) => ({ ...entry.ad, adHash: entry.hash, expiresAt: entry.expiresAt })),
      observedAt: now,
      projectionAt: state.projectionAt,
      revision: state.revision,
    }
  }

  async read(): Promise<DirectoryAgent> {
    const state = this.state()
    if (state.revision > 0 && state.checkedAt + 30 <= this.deps.now()) {
      try {
        const identity = await this.identity(state)
        this.invalidate(state, identity.wallet)
        if (this.state().revision === state.revision) {
          state.checkedAt = this.deps.now()
          state.ownership = state.wallet.toLowerCase() === identity.wallet.toLowerCase() ? 'verified' : 'changed'
          state.agentURI = identity.agentURI
          this.save(state, state.revision)
        }
      } catch (error) {
        if (!(error instanceof DirectoryError && error.code === 'chain')) throw error
      }
    }
    return this.publicView()
  }
}

export { directoryTypedData }
