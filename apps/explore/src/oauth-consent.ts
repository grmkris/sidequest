/** The consent page's Commons role opt-in (ADR-0028): the operator grants sidequest:maintain, or not, per connection. */
import type { Roles } from './commons.ts'

export const MAINTAIN_SCOPE = 'sidequest:maintain'

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

/** What the consent page approves: `maintain: true` only when the opt-in was offered and the operator ticked it. */
export function consentBody(input: {
  readonly approved: boolean
  readonly agentId: string
  readonly offer: CommonsRoleOffer | undefined
  readonly maintain: boolean
}): { decision: 'approve' | 'reject'; agentIds: string[]; maintain?: boolean } {
  return {
    decision: input.approved ? 'approve' : 'reject',
    agentIds: [input.agentId],
    ...(input.approved && input.offer !== undefined && input.maintain ? { maintain: true } : {}),
  }
}
