/** Profile writes share one durable operation across image generation, storage and signed directory publication. */
import { AgentDirectory, AgentStore, AgentSigning, BoardError, type Sql } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { AgentProfiles, PROFILE_LIMITS, type AgentProfilePatch, type ProfileUpdatedBy } from '@sidequest/board'
import { avatarPrompt, identifyAvatar, storeAvatar, type AvatarBucket, type ImageModel } from './avatars.ts'
import { profileOrigin, profileSummary, type ProfileSummary } from './profiles.ts'
import { directoryPort } from './directory-object.ts'
import { workersAiImages, type ImagesResizer, type WorkersAi } from './workers-ai-images.ts'

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Subject = bounded(600).check(Schema.isMinLength(1))
const ProfileInput = Schema.Struct({
  name: Schema.optionalKey(bounded(PROFILE_LIMITS.name)),
  description: Schema.optionalKey(bounded(PROFILE_LIMITS.description)),
  tagline: Schema.optionalKey(bounded(PROFILE_LIMITS.tagline)),
  avatar: Schema.optionalKey(Schema.Struct({ generate: Subject })),
})
export type ProfileInput = typeof ProfileInput.Type
const decode = Schema.decodeUnknownSync(ProfileInput, { onExcessProperty: 'error' })
const OperationKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))

export function profileOperationKey(input: unknown): string {
  try {
    return Schema.decodeUnknownSync(OperationKey)(input)
  } catch {
    throw new BoardError('invalid', 'Profile writes require a stable operationKey (1-128 letters, digits, _ or -)')
  }
}

export function parseProfileInput(input: unknown): ProfileInput {
  try {
    const parsed = decode(input)
    if (
      Object.keys(parsed).length === 0 ||
      (parsed.name !== undefined && parsed.name.trim().length === 0) ||
      (parsed.avatar !== undefined && parsed.avatar.generate.trim().length === 0)
    )
      throw new Error('empty profile change')
    return { ...parsed, ...(parsed.name === undefined ? {} : { name: parsed.name.trim() }) }
  } catch {
    throw new BoardError(
      'invalid',
      'Profile requires name (1-80), description (up to 600), tagline (up to 120) or avatar.generate (1-600)',
    )
  }
}

interface ProfileBindings {
  readonly Manifests?: AvatarBucket
  readonly ImageModel?: ImageModel
}

/** The host's bindings: the Manifests bucket, and an image model, Workers AI's unless one is supplied directly. */
function profileBindings(bindings: Record<string, unknown>): ProfileBindings {
  const host: ProfileBindings & { readonly AI?: WorkersAi; readonly IMAGES?: ImagesResizer } = bindings
  const model = host.ImageModel ?? (host.AI === undefined ? undefined : workersAiImages(host.AI, host.IMAGES))
  return {
    ...(host.Manifests === undefined ? {} : { Manifests: host.Manifests }),
    ...(model === undefined ? {} : { ImageModel: model }),
  }
}

/** Host bindings provide the model adapter; neither profile input nor OAuth args can select a model or bucket. */
export function managedProfileUpdates(input: {
  sql: Sql
  now: () => number
  origin: string
  boardId: string
  bindings: Record<string, unknown>
  context: sdk.Ctx
  rpcUrl: string
}): AgentProfileUpdates {
  const origin = profileOrigin(input.origin)
  const agents = new AgentStore(input.sql, input.now)
  const bindings = profileBindings(input.bindings)
  const provider = new sdk.PrivyServer({
    appId: Schema.decodeUnknownSync(Schema.String)(input.bindings.PRIVY_APP_ID ?? ''),
    appSecret: Schema.decodeUnknownSync(Schema.String)(input.bindings.PRIVY_APP_SECRET ?? ''),
    sign: async (payload) => {
      const key = Schema.decodeUnknownSync(Schema.String)(input.bindings.PRIVY_SIGNER_KEY ?? '')
      if (key === '' || key === 'unset') throw new BoardError('unavailable', 'Hosted agent signing is unavailable')
      return (await sdk.p256AuthorizationSigner(key))(payload)
    },
  })
  const signing = new AgentSigning(input.sql, input.context, provider, input.now)
  return new AgentProfileUpdates({
    ...input,
    origin,
    bucket: bindings.Manifests,
    model: bindings.ImageModel,
    directory: (id) => {
      const agent = agents.get(id)
      if (agent.agent_id === null) return undefined
      if (input.bindings.DirectoryObject === undefined)
        throw new BoardError('unavailable', 'Directory profile synchronization is unavailable')
      return new AgentDirectory({
        agents,
        signing,
        audience: origin,
        boardId: input.boardId,
        port: directoryPort(input.bindings, {
          network: input.context.deployment.network,
          rpcUrl: input.rpcUrl,
          audience: origin,
          agentId: agent.agent_id,
        }),
      })
    },
  })
}

export class AgentProfileUpdates {
  readonly agents: AgentStore
  readonly profiles: AgentProfiles
  readonly origin: string

  constructor(
    private readonly deps: {
      sql: Sql
      now: () => number
      origin: string
      boardId: string
      bucket?: AvatarBucket | undefined
      model?: ImageModel | undefined
      directory: (id: string) => AgentDirectory | undefined
    },
  ) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.profiles = new AgentProfiles(deps.sql, deps.now)
    this.origin = profileOrigin(deps.origin)
  }

  async update(id: string, key: string, input: unknown, updatedBy: ProfileUpdatedBy): Promise<ProfileSummary> {
    const parsed = parseProfileInput(input)
    const operation = this.agents.begin(id, key, this.deps.boardId, 'update_profile', { ...parsed, updatedBy })
    const done = this.agents.step<ProfileSummary>(operation.id, 'profile:done')
    if (done !== undefined) return done
    const { avatar, ...fields } = parsed
    const generated = avatar === undefined ? undefined : await this.#generate(id, operation.id, avatar.generate)
    return this.#finish(id, operation.id, { ...fields, ...generated }, updatedBy)
  }

  async upload(id: string, key: string, bytes: Uint8Array, updatedBy: ProfileUpdatedBy): Promise<ProfileSummary> {
    const stored = await identifyAvatar(bytes)
    const operation = this.agents.begin(id, key, this.deps.boardId, 'update_profile', {
      avatar: { upload: stored.key },
      updatedBy,
    })
    const done = this.agents.step<ProfileSummary>(operation.id, 'profile:done')
    if (done !== undefined) return done
    await storeAvatar(this.#bucket(), bytes)
    return this.#finish(id, operation.id, { avatarKey: stored.key, avatarPrompt: null }, updatedBy)
  }

  /** The profile as it stands now, for answers that outlive the write that made them. */
  summary(id: string): ProfileSummary {
    const agent = this.agents.get(id)
    return profileSummary(this.origin, {
      profile: this.profiles.read(id),
      agentId: agent.agent_id,
      registry: agent.registry,
      chainId: agent.chain_id,
    })
  }

  #bucket(): AvatarBucket {
    if (this.deps.bucket === undefined) throw new BoardError('unavailable', 'Avatar storage is unavailable')
    return this.deps.bucket
  }

  async #generate(
    id: string,
    operationId: string,
    subject: string,
  ): Promise<{ avatarKey: string; avatarPrompt: string }> {
    const done = this.agents.step<{ avatarKey: string; avatarPrompt: string }>(operationId, 'profile:avatar')
    if (done !== undefined) return done
    const bucket = this.#bucket()
    if (this.deps.model === undefined) throw new BoardError('unavailable', 'Avatar generation is unavailable')
    const prompt = avatarPrompt(subject)
    // Count every provider attempt before calling it, including uncertain failures. A stored result never generates again.
    this.profiles.reserveGeneration(id, new Date(this.deps.now() * 1000).toISOString().slice(0, 10))
    const generated = await this.deps.model.generate(prompt)
    const avatar = await storeAvatar(bucket, generated.bytes)
    return this.agents.freezeStep(operationId, 'profile:avatar', { avatarKey: avatar.key, avatarPrompt: prompt })
  }

  async #finish(
    id: string,
    operationId: string,
    fields: AgentProfilePatch,
    updatedBy: ProfileUpdatedBy,
  ): Promise<ProfileSummary> {
    let saved = this.agents.step<{ profile: AgentProfilePatch; syncDirectory: boolean }>(operationId, 'profile:saved')
    if (saved === undefined) {
      const before = this.profiles.read(id)
      const after = { name: fields.name ?? before.name, description: fields.description ?? before.description }
      const syncDirectory = after.name !== before.name || after.description !== before.description
      if (this.deps.sql.atomic === undefined) throw new Error('Profile writes require atomic storage')
      saved = this.deps.sql.atomic(() => {
        this.profiles.update(id, fields, updatedBy)
        return this.agents.freezeStep(operationId, 'profile:saved', { profile: after, syncDirectory })
      })
    }
    if (saved.syncDirectory) {
      const profile = this.profiles.read(id)
      await this.deps.directory(id)?.refreshProfile(id, operationId, {
        name: saved.profile.name ?? profile.name,
        description: saved.profile.description ?? profile.description,
      })
    }
    const summary = this.summary(id)
    if (this.deps.sql.atomic === undefined) throw new Error('Profile writes require atomic storage')
    return this.deps.sql.atomic(() => {
      this.agents.saveOperation(operationId, 'sending')
      this.agents.saveOperation(operationId, 'confirmed', { result: summary })
      return this.agents.freezeStep(operationId, 'profile:done', summary)
    })
  }
}
