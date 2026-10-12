/** Agent-first creation uses an operator proof captured during browser consent and a frozen creation key. */
import {
  AgentOnboarding,
  AgentStore,
  AgentSigning,
  RelaySender,
  SponsorDesk,
  BoardError,
  errorDiagnostics,
  type Sql,
  type AgentRow,
} from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { Option, Schema } from 'effect'
import { getAddress, keccak256, stringToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AgentExecuteRequest } from './agent-runtime.ts'
import type { OAuthGrant } from './oauth.ts'
import {
  managedProfileUpdates,
  parseProfileInput,
  profileOperationKey,
  type AgentProfileUpdates,
  type ProfileInput,
} from './agent-profiles.ts'
import { profileOrigin, type ProfileSummary } from './profiles.ts'
import { resourceBoard } from './oauth-validation.ts'

const CreateInput = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tagline: Schema.optionalKey(Schema.String),
  avatarPrompt: Schema.optionalKey(Schema.String),
  operationKey: Schema.String,
})
const StatusInput = Schema.Struct({ agentKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)) })
const readInput = <T>(schema: Schema.ConstraintDecoder<T>, input: unknown): T => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    throw new BoardError('invalid', 'Invalid agent setup arguments')
  }
}
const binding = (bindings: Record<string, unknown>, key: string) =>
  Schema.decodeUnknownSync(Schema.String)(bindings[key] ?? '')

interface CreationResult {
  agentKey: string
  approveUrl: string
  profile: ProfileSummary
}
interface SetupDeps {
  sql: Sql
  context: sdk.Ctx
  now: () => number
  origin: string
  onboard: (input: { id: string; operator: `0x${string}`; userId: string; name: string }) => Promise<AgentRow>
  profiles: AgentProfileUpdates
  /** Keeps work alive after the answer is sent: the Durable Object's waitUntil in production. */
  background: (work: Promise<void>) => void
}

/** Avatars being drawn in this isolate, so a retry while one is drawn never pays for a second. */
const drawing = new Set<string>()
/** The avatar request create_agent's operation recorded, as setup_status reads it back. */
const AvatarIntent = Schema.Struct({ avatar: Schema.optionalKey(Schema.Struct({ generate: Schema.String })) })

export class AgentSetup {
  readonly agents: AgentStore
  readonly origin: string
  constructor(readonly deps: SetupDeps) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.origin = profileOrigin(deps.origin)
  }

  #family(grant: OAuthGrant) {
    const row = this.deps.sql.all<{
      id: string
      operator: string
      board_id: string
      resource: string
      agent_id: string | null
      requested_scopes_json: string
    }>(
      'SELECT id,operator,board_id,resource,agent_id,requested_scopes_json FROM agent_oauth_setup_families WHERE id=? AND revoked_at IS NULL',
      grant.setupFamilyId ?? '',
    )[0]
    if (
      row === undefined ||
      row.operator !== grant.owner.toLowerCase() ||
      row.resource !== grant.resource ||
      resourceBoard(row.resource, this.origin) !== row.board_id
    )
      throw new BoardError('forbidden', 'This setup connection is unavailable for this operator and resource')
    return row
  }

  whoami(grant: OAuthGrant) {
    this.#family(grant)
    return {
      setup: true,
      operator: grant.owner,
      agents: this.agents
        .list(grant.owner)
        .map((agent) => ({ agentKey: agent.id, agentId: agent.agent_id, name: agent.name, state: agent.state })),
    }
  }

  async create(grant: OAuthGrant, args: Record<string, unknown>): Promise<CreationResult> {
    const family = this.#family(grant)
    if (grant.setup !== true || family.agent_id !== null)
      throw new BoardError('forbidden', 'This connection already acts as an agent')
    const input = readInput(CreateInput, args)
    const key = profileOperationKey(input.operationKey)
    const profile = parseProfileInput({
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.tagline === undefined ? {} : { tagline: input.tagline }),
      ...(input.avatarPrompt === undefined ? {} : { avatar: { generate: input.avatarPrompt } }),
    })
    const identity = this.deps.sql.all<{ privy_user_id: string }>(
      'SELECT privy_user_id FROM agent_setup_operators WHERE operator=?',
      family.operator,
    )[0]
    if (identity === undefined)
      throw new BoardError(
        'conflict',
        'Confirm your operator wallet ownership during browser consent before creating an agent',
      )
    const id = `setup_${keccak256(stringToHex(JSON.stringify([family.operator, family.board_id, family.resource, key]))).slice(2, 50)}`
    const associated = this.deps.sql.all<{ agent_key: string }>(
      'SELECT agent_key FROM agent_setup_connections WHERE family_id=?',
      family.id,
    )[0]
    if (associated !== undefined && associated.agent_key !== id)
      throw new BoardError(
        'conflict',
        'This setup connection is already creating another agent; resume its operationKey',
      )
    const creation = { id, operator: getAddress(family.operator), userId: identity.privy_user_id, name: profile.name! }
    if (this.deps.sql.all('SELECT id FROM agents WHERE id=?', id).length === 0)
      this.agents.create({
        id,
        operator: creation.operator,
        privyUserId: creation.userId,
        name: creation.name,
        registry: this.deps.context.deployment.identity,
        chainId: this.deps.context.deployment.chainId,
      })
    const operation = this.agents.begin(id, 'setup-create', family.board_id, 'create_agent', {
      ...profile,
      operationKey: key,
    })
    this.#associate(family, id)
    const { avatar, ...fields } = profile
    const saved = this.agents.step<CreationResult>(operation.id, 'setup-result')
    // A retry restarts a draw that failed, and shows the avatar once it is drawn.
    if (saved !== undefined) {
      this.#drawAvatar(id, avatar)
      return { ...saved, profile: this.deps.profiles.summary(id) }
    }
    try {
      await this.deps.onboard(creation)
      const summary = await this.deps.profiles.update(id, 'setup-fields', fields, 'agent')
      const result = this.agents.freezeStep(operation.id, 'setup-result', {
        agentKey: id,
        approveUrl: approveUrl(this.origin, id, family.requested_scopes_json),
        profile: summary,
      })
      this.#drawAvatar(id, avatar)
      return result
    } catch (error) {
      // Store no provider message: it may contain credentials or request bodies.
      this.agents.freezeStep(operation.id, 'setup-interrupted', {
        message: 'Agent setup was interrupted. Retry create_agent with the original operationKey and arguments.',
      })
      throw error
    }
  }

  #associate(family: { id: string; board_id: string; resource: string }, id: string) {
    this.deps.sql.run(
      'INSERT OR IGNORE INTO agent_setup_connections (agent_key,family_id,board_id,resource,created_at) VALUES (?,?,?,?,?)',
      id,
      family.id,
      family.board_id,
      family.resource,
      this.deps.now(),
    )
    const association = this.deps.sql.all<{ agent_key: string }>(
      'SELECT agent_key FROM agent_setup_connections WHERE family_id=?',
      family.id,
    )[0]
    if (association?.agent_key !== id)
      throw new BoardError(
        'conflict',
        'This setup connection is already creating another agent; resume its operationKey',
      )
  }

  /** The image model takes long enough to time clients out, so create_agent answers first and the avatar follows. */
  #drawAvatar(id: string, avatar: ProfileInput['avatar']) {
    if (avatar === undefined || drawing.has(id) || this.deps.profiles.profiles.read(id).avatarKey !== null) return
    drawing.add(id)
    this.deps.background(
      this.deps.profiles
        .update(id, 'setup-avatar', { avatar }, 'agent')
        .then(
          () => undefined,
          (error: unknown) =>
            console.error(JSON.stringify({ event: 'avatar-draw-failed', agentKey: id, ...errorDiagnostics(error) })),
        )
        .finally(() => drawing.delete(id)),
    )
  }

  /**
   * Restarts an avatar draw the Durable Object lost (an eviction or a deploy ends work kept past the answer): the
   * request stays in create_agent's operation, and setup_status is polled while the agent waits for approval.
   */
  #resumeAvatar(agentKey: string) {
    const row = this.deps.sql.all<{ intent_json: string }>(
      "SELECT intent_json FROM agent_operations WHERE agent_id=? AND action_key='setup-create' AND tool='create_agent'",
      agentKey,
    )[0]
    const avatar =
      row === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(AvatarIntent))(row.intent_json))
            ?.avatar
    if (avatar !== undefined) this.#drawAvatar(agentKey, avatar)
  }

  /** Any setup connection of the operator may ask: a reconnect must not lose track of the agent it waits for. */
  status(grant: OAuthGrant, args: Record<string, unknown>) {
    const family = this.#family(grant)
    const { agentKey } = readInput(StatusInput, args)
    const owned = this.deps.sql.all<{ id: string }>(
      'SELECT id FROM agents WHERE id=? AND operator=?',
      agentKey,
      family.operator,
    )[0]
    if (owned === undefined) throw new BoardError('forbidden', 'No agent with this key belongs to this operator')
    const agent = this.agents.get(agentKey)
    if (agent.state === 'revoked') return { state: 'failed', message: 'Hosted access to this agent was stopped.' }
    this.#resumeAvatar(agentKey)
    if (family.agent_id === agentKey && agent.state === 'active')
      return {
        state: 'ready',
        agentId: agent.agent_id,
        message: 'Call whoami to verify this agent before continuing; its tools now work on this connection.',
      }
    if (family.agent_id !== null)
      return { state: 'failed', message: 'This connection already acts as another agent. Call whoami.' }
    const operation = this.deps.sql.all<{ id: Hex }>(
      "SELECT id FROM agent_operations WHERE agent_id=? AND action_key='setup-create' AND tool='create_agent'",
      agentKey,
    )[0]
    if (
      operation !== undefined &&
      this.agents.step(operation.id, 'setup-result') === undefined &&
      this.agents.step(operation.id, 'setup-interrupted') !== undefined
    )
      return {
        state: 'failed',
        message: 'Agent setup was interrupted. Retry create_agent with the original operationKey and arguments.',
      }
    return {
      state: 'awaiting-approval',
      message:
        'Your operator must register and connect the agent on its approval page. Do not reconnect; keep polling.',
    }
  }
}

/** The approval page pre-ticks the roles the client asked for; the operator still chooses there. */
function approveUrl(origin: string, id: string, requestedScopes: string) {
  const requested = Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(requestedScopes))
  const roles = ['work', 'hire'].filter((role) => requested.includes(`sidequest:${role}`))
  return `${origin}/agents/approve/${id}${roles.length === 0 ? '' : `?roles=${roles.join(',')}`}`
}

function managedAgentSetup(input: {
  sql: Sql
  context: sdk.Ctx
  now: () => number
  origin: string
  boardId: string
  bindings: Record<string, unknown>
  rpcUrl: string
  relayKey: Hex
  background: (work: Promise<void>) => void
}): AgentSetup {
  const { sql, context, now, bindings } = input
  const provider = new sdk.PrivyServer({
    appId: binding(bindings, 'PRIVY_APP_ID'),
    appSecret: binding(bindings, 'PRIVY_APP_SECRET'),
    sign: async (payload) => (await sdk.p256AuthorizationSigner(binding(bindings, 'PRIVY_SIGNER_KEY')))(payload),
  })
  const onboard = async (creation: { id: string; operator: `0x${string}`; userId: string; name: string }) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.relayKey))
      throw new BoardError('unavailable', 'The hosted-agent relay is unavailable')
    const relayAccount = privateKeyToAccount(input.relayKey)
    const sponsor = new SponsorDesk({
      sql,
      ctx: context,
      now,
      relay: { account: relayAccount, rpcUrl: input.rpcUrl },
      fail: (code, message) => new BoardError(code, message),
    })
    return new AgentOnboarding({
      sql,
      context,
      now,
      publicOrigin: input.origin,
      sponsor,
      signing: new AgentSigning(sql, context, provider, now),
      signerId: binding(bindings, 'PRIVY_SIGNER_ID'),
      policyId: binding(bindings, 'PRIVY_POLICY_ID'),
      relay: new RelaySender(sql, context, relayAccount, input.rpcUrl, now),
    }).create(creation, provider)
  }
  return new AgentSetup({ ...input, onboard, profiles: managedProfileUpdates(input) })
}

export async function runSetupTool(input: {
  req: AgentExecuteRequest
  bindings: Record<string, unknown>
  sql: Sql
  grant: OAuthGrant
  background: (work: Promise<void>) => void
}) {
  const { req, bindings, sql, grant } = input
  // SAFETY: the relay key comes from the private host request; the factory validates it before creating an account.
  const relayKey = req.env.relayKey as Hex
  const setup = managedAgentSetup({
    sql,
    context: sdk.context(req.env.network, 'main', req.env.rpcUrl),
    now: () => Math.floor(Date.now() / 1000),
    origin: new URL(req.resource).origin,
    boardId: req.env.boardId,
    bindings,
    rpcUrl: req.env.rpcUrl,
    relayKey,
    background: input.background,
  })
  if (req.tool === 'whoami' && grant.setup === true) return setup.whoami(grant)
  if (req.tool === 'create_agent' && grant.setup === true) return setup.create(grant, req.args)
  if (req.tool === 'setup_status') return setup.status(grant, req.args)
  throw new BoardError('forbidden', 'This connection does not grant this setup tool')
}
