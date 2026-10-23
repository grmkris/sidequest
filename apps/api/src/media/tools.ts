/**
 * The media tools (ADR-0029), run in the API Worker for REST (`/api/<tool>`, a signed-in wallet) and hosted MCP (an
 * agent acting with its operator's team role) alike. The reads are on every connection and show internal media only to
 * the team; the rest need the `sidequest:media` scope and a team role, which the store checks again.
 */
import { BoardError } from '@sidequest/board'
import type { MediaActor } from './access.ts'
import { replayed } from './commit.ts'
import { MEDIA_READ_TOOLS, MEDIA_TEAM_TOOLS } from './names.ts'
import { type MediaDeps, type MediaTool, writeContext } from './tool-kit.ts'
import { libraryTools } from './tools-library.ts'
import { planTools } from './tools-plan.ts'

export type { MediaDeps, MediaTool } from './tool-kit.ts'
export { MEDIA_READ_TOOLS }

export const mediaTools: Readonly<Record<string, MediaTool>> = { ...libraryTools, ...planTools }

export const isMediaTool = (name: string): boolean => Object.hasOwn(mediaTools, name)

/**
 * The writes a retry answers from the log before running again. A share answers its link, which is never stored, so
 * it replays inside its own run; an upload link is not a write.
 */
const REPLAYED: ReadonlySet<string> = new Set(
  [...MEDIA_TEAM_TOOLS].filter((name) => name !== 'share_media' && name !== 'prepare_media_upload'),
)

export type MediaReply =
  | { readonly ok: true; readonly result: object }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Runs one media tool and answers the board's reply shape; a refusal keeps its code. */
export async function runMediaTool(
  deps: MediaDeps,
  actor: MediaActor,
  name: string,
  args: Record<string, unknown>,
): Promise<MediaReply> {
  const tool = mediaTools[name]
  if (tool === undefined) return { ok: false, code: 'not-found', message: `no media tool ${name}` }
  try {
    const earlier = REPLAYED.has(name) ? await replayed(deps.sql, writeContext(deps, actor, name, args)) : undefined
    if (earlier !== undefined)
      // SAFETY: the log holds the object this tool answered the first time for these arguments.
      return { ok: true, result: earlier.result as object }
    return { ok: true, result: await tool.run(deps, actor, args) }
  } catch (error) {
    if (error instanceof BoardError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}
