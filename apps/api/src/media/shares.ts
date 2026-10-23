/** Shares (ADR-0029): internal assets handed to someone outside the team by link, until it expires or is revoked. */
import { BoardError } from '@sidequest/board'
import { type AsyncSql, stmt } from '@sidequest/indexer'
import { actorName, type MediaActor, requireRole } from './access.ts'
import { commit, type WriteContext } from './commit.ts'
import { assetRow, idsOf, optional, type ShareRow } from './rows.ts'

export interface NewShare {
  readonly id: string
  /** The token's hash; the token itself is never stored. */
  readonly hash: string
  readonly assets: readonly string[]
  readonly label?: string
  readonly expires: number
}

export async function createShare(sql: AsyncSql, ctx: WriteContext, input: NewShare) {
  requireRole(ctx.actor, 'member')
  for (const asset of input.assets) {
    const row = await assetRow(sql, asset)
    if (row === undefined || row.deleted_at !== null) throw new BoardError('invalid', `no media asset "${asset}"`)
  }
  return commit(sql, ctx, {
    action: 'share.create',
    target: input.id,
    guard: stmt(
      'INSERT INTO media_shares (id, token_hash, label, asset_ids_json, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.id,
      input.hash,
      input.label ?? null,
      JSON.stringify(input.assets),
      input.expires,
      actorName(ctx.actor),
      ctx.now,
    ),
    writes: [],
    result: { id: input.id, expiresAt: input.expires, assets: input.assets },
    refused: new BoardError('conflict', 'that share exists'),
  })
}

export async function revokeShare(sql: AsyncSql, ctx: WriteContext, input: { readonly id: string }) {
  requireRole(ctx.actor, 'member')
  return commit(sql, ctx, {
    action: 'share.revoke',
    target: input.id,
    guard: stmt('UPDATE media_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', ctx.now, input.id),
    writes: [],
    result: { id: input.id, revoked: true },
    refused: new BoardError('not-found', `no live share "${input.id}"`),
  })
}

/** Every share the team made, live or not; never a token. */
export async function listShares(sql: AsyncSql, actor: MediaActor, now: number) {
  requireRole(actor, 'member')
  const rows = await sql.all<ShareRow>('SELECT * FROM media_shares ORDER BY created_at DESC LIMIT 200')
  return {
    shares: rows.map((row) => ({
      id: row.id,
      ...optional('label', row.label),
      assets: idsOf(row.asset_ids_json),
      expiresAt: row.expires_at,
      live: row.revoked_at === null && row.expires_at > now,
      ...optional('revokedAt', row.revoked_at),
      createdBy: row.created_by,
      createdAt: row.created_at,
    })),
  }
}

/** A live share by its token's hash: its label, expiry and assets. */
export async function liveShare(sql: AsyncSql, hash: string, now: number) {
  const [row] = await sql.all<ShareRow>(
    'SELECT * FROM media_shares WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
    hash,
    now,
  )
  return row === undefined
    ? undefined
    : { id: row.id, label: row.label, expiresAt: row.expires_at, assets: idsOf(row.asset_ids_json) }
}
