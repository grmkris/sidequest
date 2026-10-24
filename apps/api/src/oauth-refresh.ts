/**
 * Refresh-token rotation with a short reuse grace, for agent and setup connections alike. A refresh token is single
 * use, and one presented again usually means it leaked, so the whole connection is revoked. A client that lost the
 * response to its refresh, or a supervisor restarted mid-refresh, presents the same token seconds later (prod gap 9:
 * Patch's connection was revoked that way). Within the grace of its first use it gets a fresh pair instead, and the
 * family's other live refresh tokens retire, so one stays live; after the grace the reuse revokes the connection.
 */
import type { Sql } from '@sidequest/board'

const REFRESH_REUSE_GRACE_SECONDS = 60

/** What a refresh did with the token it was given: first use, a reuse within the grace, or a replay to revoke. */
export type RefreshUse = 'rotated' | 'grace' | 'replayed'

/** The token and family tables of each kind of connection. */
const TABLES = {
  agent: { tokens: 'agent_oauth_tokens', families: 'agent_oauth_families' },
  setup: { tokens: 'agent_oauth_setup_tokens', families: 'agent_oauth_setup_families' },
} as const

/**
 * Inside the caller's transaction: consumes a live refresh token, or decides a reused one (consumedAt set). A replay
 * revokes its family here; the caller then ends the family's grants and subscriptions as for any revocation.
 */
export function useRefreshToken(
  sql: Sql,
  kind: keyof typeof TABLES,
  token: { readonly hash: string; readonly familyId: string; readonly consumedAt: number | null },
  now: number,
): RefreshUse {
  const { tokens, families } = TABLES[kind]
  if (token.consumedAt === null) {
    sql.run(`UPDATE ${tokens} SET consumed_at=? WHERE hash=?`, now, token.hash)
    return 'rotated'
  }
  if (now - token.consumedAt > REFRESH_REUSE_GRACE_SECONDS) {
    sql.run(`UPDATE ${families} SET revoked_at=? WHERE id=?`, now, token.familyId)
    return 'replayed'
  }
  sql.run(
    `UPDATE ${tokens} SET consumed_at=? WHERE family_id=? AND kind='refresh' AND consumed_at IS NULL`,
    now,
    token.familyId,
  )
  return 'grace'
}

/** The token endpoint's answer when a refresh token came back after the grace. */
const REFRESH_REPLAYED = `Refresh token reused more than ${REFRESH_REUSE_GRACE_SECONDS} seconds after its first use, so this connection was revoked to protect it; sign in again`

/** Why the token endpoint issued nothing, one reason each, so a client knows whether to retry or sign in again. */
export const TOKEN_REFUSALS = {
  stopped: 'Agent access stopped: its operator paused or revoked this agent',
  used: 'Authorization code already used, or the connection was revoked; sign in again',
  replayed: REFRESH_REPLAYED,
} as const
