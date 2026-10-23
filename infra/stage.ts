import dev from './dev.json' with { type: 'json' }
import prod from './prod.json' with { type: 'json' }
import { Schema } from 'effect'
import type { Address } from 'viem'

const RoleAddresses = Schema.Array(Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)))
const StageRoles = Schema.Struct({ moderator: RoleAddresses, maintainer: RoleAddresses })
const StageMedia = Schema.Struct({
  team: Schema.Array(
    Schema.Struct({
      wallet: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)),
      role: Schema.Literals(['operator', 'member']),
    }),
  ),
  timezone: Schema.String,
  pullHosts: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+\.[a-z]{2,}$/u))),
})

/** Sidequest's media team (ADR-0029): who sees the internal library, and who may publish and approve. */
export interface StageMedia {
  team: readonly { wallet: Address; role: 'operator' | 'member' }[]
  /** The digest's local day and the post plan's times, an IANA zone. */
  timezone: string
  /** Hosts `add_media({ sourceUrl })` may fetch from. */
  pullHosts: readonly string[]
}

const RESOURCES = ['Api', 'Indexer', 'Explore', 'Database', 'Manifests', 'Media'] as const

export interface StageProfile {
  product: string
  stage: 'dev' | 'prod'
  network: 'monad-testnet' | 'monad-mainnet'
  chainId: number
  origin: string
  /** Legacy testnet relay; absent on mainnet (ADR-0023). */
  relay?: `0x${string}`
  telegram: { botUsername: string }
  cloudflare: { accountId?: string; zoneId: string; zoneName: string }
  resources: Record<(typeof RESOURCES)[number], string>
  safeInfrastructure: { factory: `0x${string}`; singleton: `0x${string}`; fallbackHandler: `0x${string}` }
  /** Hosted board policy. `requirePosterAgent` (ADR-0019): only agents post; absent or false, anyone may. */
  boards?: { requirePosterAgent?: boolean }
  roles?: { moderator: Address[]; maintainer: Address[] }
  media?: StageMedia
}

function validateMedia(media: unknown): void {
  const value = Schema.decodeUnknownSync(StageMedia)(media)
  if (!Intl.supportedValuesOf('timeZone').includes(value.timezone)) throw new Error('Invalid media timezone')
  const wallets = value.team.map((member) => member.wallet.toLowerCase())
  if (new Set(wallets).size !== wallets.length) throw new Error('Duplicate media team wallet')
}

const profiles = { dev, prod }

export function validateStageProfile(profile: unknown, stage: 'dev' | 'prod'): StageProfile {
  const value = profile as StageProfile
  if (
    value?.stage !== stage ||
    !['monad-testnet', 'monad-mainnet'].includes(value.network) ||
    value.chainId !== (value.network === 'monad-mainnet' ? 143 : 10143)
  )
    throw new Error('Stage network/chain mismatch')
  if (
    new URL(value.origin).origin !== value.origin ||
    (value.network === 'monad-testnet' && !/^0x[0-9a-fA-F]{40}$/.test(value.relay ?? ''))
  )
    throw new Error('Invalid stage origin/relay')
  if (value.roles !== undefined) Schema.decodeUnknownSync(StageRoles)(value.roles)
  if (value.media !== undefined) validateMedia(value.media)
  for (const name of RESOURCES) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value.resources?.[name] ?? '')) throw new Error('Invalid stage resource')
  }
  return value
}

/** Resolve the committed stage contract. Local development keeps its caller-selected network and resources. */
export function stageProfile(stage: string | undefined = process.env.SIDEQUEST_STAGE): StageProfile | undefined {
  if (stage === 'dev' || stage === 'prod') return validateStageProfile(profiles[stage], stage)
  if (stage === undefined || stage === 'local') return undefined
  throw new Error(`Unknown Sidequest stage: ${stage}`)
}
