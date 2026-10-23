/**
 * The consent page's opt-ins for scopes only an operator grants: the Commons role tools (ADR-0028,
 * sidequest:maintain) and the media team's tools (ADR-0029, sidequest:media), each per connection.
 */
import type { Roles } from './commons.ts'

export const MAINTAIN_SCOPE = 'sidequest:maintain'
const MEDIA_SCOPE = 'sidequest:media'

/** The media team role a connection would act with: its operator's, as the server answers it. */
export type MediaOffer = 'operator' | 'member'

/**
 * Whether the consent page offers the media team's tools, and with which role: only when the client asked for
 * sidequest:media and the server says the signed-in operator is on the media team. The team list never reaches the page.
 */
export function mediaOffer(
  scopes: readonly string[] | undefined,
  offered: string | null | undefined,
): MediaOffer | undefined {
  if (scopes?.includes(MEDIA_SCOPE) !== true) return undefined
  return offered === 'operator' || offered === 'member' ? offered : undefined
}

/** The Commons role a connection may use the role tools as: a Maintainer has all seven, a Moderator hide and unhide. */
export type CommonsRoleOffer = 'maintainer' | 'moderator'

/**
 * Whether the consent page offers the Commons role tools to this connection, and as which role: only when its client
 * asked for sidequest:maintain and the chosen agent's wallet holds a Commons role that has them (the stage's role list,
 * read through list_roles). Nothing is offered while that read is pending, failed or Commons is off.
 */
export function commonsRoleOffer(
  scopes: readonly string[] | undefined,
  roles: Pick<Roles, 'enabled' | 'roles'> | undefined,
  wallet: string | null | undefined,
): CommonsRoleOffer | undefined {
  if (scopes?.includes(MAINTAIN_SCOPE) !== true || roles?.enabled !== true || wallet === null || wallet === undefined)
    return undefined
  const holds = (role: CommonsRoleOffer) =>
    roles.roles.some(
      (entry) => entry.role === role && entry.holders.some((holder) => holder.toLowerCase() === wallet.toLowerCase()),
    )
  if (holds('maintainer')) return 'maintainer'
  if (holds('moderator')) return 'moderator'
  return undefined
}

/** What the consent page approves: each opt-in `true` only when it was offered and the operator ticked it. */
export function consentBody(input: {
  readonly approved: boolean
  readonly agentId: string
  readonly offer: CommonsRoleOffer | undefined
  readonly maintain: boolean
  readonly mediaOffer?: MediaOffer | undefined
  readonly media?: boolean
}): { decision: 'approve' | 'reject'; agentIds: string[]; maintain?: boolean; media?: boolean } {
  return {
    decision: input.approved ? 'approve' : 'reject',
    agentIds: [input.agentId],
    ...(input.approved && input.offer !== undefined && input.maintain ? { maintain: true } : {}),
    ...(input.approved && input.mediaOffer !== undefined && input.media === true ? { media: true } : {}),
  }
}
