/**
 * Who is asking for media (ADR-0029). A signed-in wallet acts with its own team role; a hosted agent acts with its
 * operator's role, and only on a connection its operator granted `sidequest:media`. Everyone else sees public media.
 */
import { BoardError } from '@sidequest/board'
import { stageMediaOf } from '@sidequest/indexer/media-digest'
import type { StageMedia } from '../../../../infra/stage.ts'

export type { StageMedia }
import { MEDIA_SCOPE } from '../oauth-validation.ts'

export type MediaRole = 'operator' | 'member'

export type MediaActor =
  | { readonly kind: 'public' }
  | { readonly kind: 'wallet'; readonly wallet: string; readonly role: MediaRole | undefined }
  | {
      readonly kind: 'agent'
      readonly agentId: string
      readonly operator: string
      /** The operator's role, when the connection holds the media scope. */
      readonly role: MediaRole | undefined
    }

/** The media team of a deployed stage, read at runtime from the bundled profile; none locally. */
export const stageMedia = stageMediaOf

export function teamRole(media: StageMedia | undefined, wallet: string | undefined): MediaRole | undefined {
  if (wallet === undefined) return undefined
  return media?.team.find((member) => member.wallet.toLowerCase() === wallet.toLowerCase())?.role
}

export const walletActor = (media: StageMedia | undefined, wallet: string | undefined): MediaActor =>
  wallet === undefined ? { kind: 'public' } : { kind: 'wallet', wallet, role: teamRole(media, wallet) }

export const agentActor = (
  media: StageMedia | undefined,
  grant: { readonly owner: string; readonly scopes: readonly string[] },
  agentId: string,
): MediaActor => ({
  kind: 'agent',
  agentId,
  operator: grant.owner,
  role: grant.scopes.includes(MEDIA_SCOPE) ? teamRole(media, grant.owner) : undefined,
})

export const roleOf = (actor: MediaActor): MediaRole | undefined => (actor.kind === 'public' ? undefined : actor.role)
export const isTeam = (actor: MediaActor): boolean => roleOf(actor) !== undefined

/** The actor's stable name in the log and in `created_by` columns. */
export function actorName(actor: MediaActor): string {
  switch (actor.kind) {
    case 'wallet':
      return `wallet:${actor.wallet.toLowerCase()}`
    case 'agent':
      return `agent:${actor.agentId}`
    case 'public':
      return 'public'
  }
}

/** Refuses an actor below the role a tool needs; members do most work, operators make things public. */
export function requireRole(actor: MediaActor, needed: MediaRole): void {
  const role = roleOf(actor)
  if (role === undefined)
    throw new BoardError(
      'forbidden',
      actor.kind === 'agent'
        ? "this agent's connection has no media access: its operator must be on the media team and tick Media at consent"
        : 'only the media team sees and changes internal media',
    )
  if (needed === 'operator' && role !== 'operator')
    throw new BoardError('forbidden', 'only a media operator publishes, approves, edits sections and deletes')
}
