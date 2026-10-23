/** What every media tool shares (ADR-0029): its dependencies, its shape, the write context and the viewer's file links. */
import type { AsyncSql } from '@sidequest/indexer'
import type { Schema } from 'effect'
import { BoardError } from '@sidequest/board'
import type { StageMedia } from '../../../../infra/stage.ts'
import type { McpTool } from '../mcp.ts'
import { actorName, isTeam, type MediaActor } from './access.ts'
import { jsonSchemaOf, operationKeyOf, parse } from './args.ts'
import type { WriteContext } from './commit.ts'
import type { FileLink } from './rows.ts'
import type { MediaBucket } from './serve.ts'
import { previewExpiry, previewToken } from './tokens.ts'

export interface MediaDeps {
  readonly sql: AsyncSql
  readonly bucket: MediaBucket | undefined
  readonly media: StageMedia | undefined
  readonly signingKey: string
  /** The site origin file and share URLs are built on. */
  readonly origin: string
  readonly now: () => number
  readonly fetch: typeof fetch
}

export interface MediaTool extends McpTool {
  readonly description: string
  readonly inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: readonly string[] }
  readonly run: (deps: MediaDeps, actor: MediaActor, args: Record<string, unknown>) => Promise<object>
}

type Decodable = Schema.Top & { readonly DecodingServices: never }

/** A tool whose arguments are parsed by `schema` before `run` sees them; `args` stays for the write's digest. */
export function mediaTool<S extends Decodable>(
  description: string,
  schema: S,
  run: (deps: MediaDeps, actor: MediaActor, input: S['Type'], args: Record<string, unknown>) => Promise<object>,
): MediaTool {
  return {
    description,
    inputSchema: jsonSchemaOf(schema),
    run: (deps, actor, args) => run(deps, actor, parse(schema, args), args),
  }
}

export const writeContext = (
  deps: MediaDeps,
  actor: MediaActor,
  tool: string,
  args: Record<string, unknown>,
): WriteContext => ({ actor, operationKey: operationKeyOf(args), tool, args, now: deps.now() })

/** File URLs for this viewer: public `?v=`, a team preview `?p=`, or a share's `?s=`. */
export function linker(deps: MediaDeps, actor: MediaActor, share?: string): FileLink {
  const previews = new Map<string, Promise<string>>()
  const expires = previewExpiry(deps.now())
  return async (asset, file) => {
    const base = `${deps.origin}/media/f/${asset.id}/${file.name}`
    if (asset.public) return `${base}?v=${file.sha256.slice(0, 8)}`
    if (share !== undefined) return `${base}?s=${share}`
    if (!isTeam(actor) || deps.signingKey === '') return null
    const token = previews.get(asset.id) ?? previewToken(deps.signingKey, asset.id, expires)
    previews.set(asset.id, token)
    return `${base}?p=${await token}`
  }
}

/** A share's token, the same for the same actor and operationKey, so a retried share answers the same link. */
export async function shareToken(deps: MediaDeps, actor: MediaActor, key: string): Promise<string> {
  if (deps.signingKey.length < 32) throw new BoardError('unavailable', 'shares are not configured here')
  const encoder = new TextEncoder()
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(deps.signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign('HMAC', hmac, encoder.encode(`media-share-v1|${actorName(actor)}|${key}`))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const randomId = (prefix: string) =>
  `${prefix}${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`

export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
