/**
 * A hosted agent's own listing in the worker directory (WS8): advertise a service, take one down, or leave the
 * directory. The directory prepares each record; it is frozen in the operation's journal, signed once by the agent's
 * hosted wallet within the directory signing scope, then submitted. A retry with the same operationKey resumes from
 * the journal, and a record that fell outside the directory's server-time window is prepared again, at most three
 * times. Listing is discovery only: it grants no job, money or signing authority.
 */
import type * as sdk from '@sidequest/sdk'
import { type Hex, zeroAddress } from 'viem'
import { AgentFailure } from './agent-failure.ts'
import type { AgentSigning } from './agent-signing.ts'
import type { AgentStore } from './agents.ts'
import { DirectoryError, validateAdvertisement } from './directory.ts'
import { AgentProfiles } from './agent-profiles.ts'

/** The agent's directory object: its current listing, and records it prepares and accepts. */
export interface DirectoryPort {
  read(): Promise<sdk.DirectoryAgent>
  prepare(kind: sdk.DirectoryKind, payload: unknown): Promise<sdk.DirectoryEnvelope>
  submit(record: sdk.DirectoryEnvelope, signature: Hex): Promise<sdk.DirectoryAgent>
}

const ATTEMPTS = 3
/** Refusals a freshly prepared record fixes: it expired, or another record of the same kind was accepted since. */
const STALE = /server-time validity window|expired during verification|stale generation or replayed nonce/

const failure = (error: unknown): never => {
  if (!(error instanceof DirectoryError)) throw error
  const code = error.code === 'chain' ? 'unavailable' : error.code
  throw new AgentFailure(
    code,
    error.message,
    `directory-${error.code}`,
    error.code === 'invalid' || error.code === 'forbidden' ? 'new-key' : 'same-key',
    error.retryAfter,
  )
}

const refusing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    return failure(error)
  }
}

function advertisement(ad: sdk.DirectoryAgent['ads'][number]): sdk.ServiceAdvertisement {
  return {
    serviceId: ad.serviceId,
    name: ad.name,
    description: ad.description,
    inputs: ad.inputs,
    outputs: ad.outputs,
    turnaroundSeconds: ad.turnaroundSeconds,
    price: ad.price,
    ...(ad.category === undefined ? {} : { category: ad.category }),
    ...(ad.tags === undefined ? {} : { tags: ad.tags }),
    ...(ad.examples === undefined ? {} : { examples: ad.examples }),
    ...(ad.samples === undefined ? {} : { samples: ad.samples }),
  }
}

export class AgentDirectory {
  constructor(
    private readonly deps: {
      agents: AgentStore
      signing: AgentSigning
      audience: string
      boardId: string
      port: DirectoryPort
    },
  ) {}

  /** Lists `ad` until withdrawn, enrolling in manual mode only when unlisted or the wallet's ownership changed. */
  async advertise(id: string, key: string, ad: unknown): Promise<sdk.DirectoryAgent> {
    const checked = await refusing(() => validateAdvertisement(ad, this.deps.audience))
    const operation = this.deps.agents.begin(id, key, this.deps.boardId, 'advertise_service', { ad: checked })
    // A finished operation answers from its journal: a retry must not enroll again after a later opt-out.
    const done = this.deps.agents.step<sdk.DirectoryAgent>(operation.id, 'ad:done')
    if (done !== undefined) return done
    const listing = await refusing(() => this.deps.port.read())
    if (!listing.enrolled || listing.ownership === 'changed') {
      const profile = new AgentProfiles(this.deps.agents.sql, this.deps.agents.now).read(id)
      await this.#record(operation.id, 'enroll', id, 'Enrollment', {
        profile: {
          name: profile.name,
          description: profile.description,
          services: [...new Set([...listing.ads.map((live) => live.name), checked.name])],
        },
        delegate: zeroAddress,
        adDelegate: false,
        grantExpiresAt: 0,
        enrolled: true,
      })
    }
    return this.#record(operation.id, 'ad', id, 'ServiceAd', checked)
  }

  /** Enrollment revokes every ad, so freeze the live set before replacing it and resume each publication on retry. */
  async refreshProfile(id: string, operationId: string, profile: { name: string; description: string }): Promise<void> {
    const operation = this.deps.agents.operation(operationId)
    if (operation.agent_id !== id)
      throw new AgentFailure('forbidden', 'Profile operation belongs to another agent', 'profile-owner', 'none')
    if (this.deps.agents.step<boolean>(operationId, 'profile-directory:done') === true) return
    const listing =
      this.deps.agents.step<sdk.DirectoryAgent>(operationId, 'profile-directory:listing') ??
      this.deps.agents.freezeStep(operationId, 'profile-directory:listing', await refusing(() => this.deps.port.read()))
    if (listing.enrolled) {
      const liveAds = listing.ads.filter((ad) => ad.expiresAt === null || ad.expiresAt > this.deps.agents.now())
      await this.#record(operationId, 'profile-directory:enroll', id, 'Enrollment', {
        profile: { ...profile, services: [...new Set(liveAds.map((ad) => ad.name))] },
        delegate: zeroAddress,
        adDelegate: false,
        grantExpiresAt: 0,
        enrolled: true,
      })
      for (const ad of liveAds) {
        // Enrollment or a previous publication may have waited past this ad's original expiry.
        if (ad.expiresAt !== null && ad.expiresAt <= this.deps.agents.now()) continue
        const service = advertisement(ad)
        await this.#record(operationId, `profile-directory:ad:${ad.serviceId}`, id, 'ServiceAd', service)
      }
    }
    this.deps.agents.freezeStep(operationId, 'profile-directory:done', true)
  }

  /** Takes one service down (`serviceId`), or without one removes the agent from the directory with all its ads. */
  async withdraw(id: string, key: string, input: { serviceId?: string }): Promise<sdk.DirectoryAgent> {
    const operation = this.deps.agents.begin(
      id,
      key,
      this.deps.boardId,
      'withdraw_service',
      input.serviceId === undefined ? {} : { serviceId: input.serviceId },
    )
    if (input.serviceId !== undefined)
      return this.#record(operation.id, 'revoke', id, 'RevokeAd', { serviceId: input.serviceId })
    const done = this.deps.agents.step<sdk.DirectoryAgent>(operation.id, 'leave:done')
    if (done !== undefined) return done
    const listing = await refusing(() => this.deps.port.read())
    return this.#record(operation.id, 'leave', id, 'Enrollment', {
      profile: listing.profile,
      delegate: zeroAddress,
      adDelegate: false,
      grantExpiresAt: 0,
      enrolled: false,
    })
  }

  async #record(
    operationId: string,
    step: string,
    id: string,
    kind: sdk.DirectoryKind,
    payload: unknown,
  ): Promise<sdk.DirectoryAgent> {
    const done = this.deps.agents.step<sdk.DirectoryAgent>(operationId, `${step}:done`)
    if (done !== undefined) return done
    for (let attempt = 0; ; attempt++) {
      const name = `${step}:${attempt}`
      const record =
        this.deps.agents.step<sdk.DirectoryEnvelope>(operationId, name) ??
        this.deps.agents.freezeStep(operationId, name, await refusing(() => this.deps.port.prepare(kind, payload)))
      const signature = await this.deps.signing.signDirectory(id, record, this.deps.audience, async () => record)
      try {
        return this.deps.agents.freezeStep(operationId, `${step}:done`, await this.deps.port.submit(record, signature))
      } catch (error) {
        if (error instanceof DirectoryError && STALE.test(error.message) && attempt + 1 < ATTEMPTS) continue
        return failure(error)
      }
    }
  }
}
