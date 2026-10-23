/**
 * The media tools (ADR-0029), run in the API Worker for REST (`/api/<tool>`, a signed-in wallet) and hosted MCP (an
 * agent acting with its operator's team role) alike. The reads are on every connection and show internal media only to
 * the team; the rest need the `sidequest:media` scope and a team role, which the store checks again.
 */
import { BoardError } from '@sidequest/board'
import type { MediaActor } from './access.ts'
import { MEDIA_READ_TOOLS } from './names.ts'
import type { MediaDeps, MediaTool } from './tool-kit.ts'
import { libraryTools } from './tools-library.ts'
import { planTools } from './tools-plan.ts'

export type { MediaDeps, MediaTool } from './tool-kit.ts'
export { MEDIA_READ_TOOLS }

export const mediaTools: Readonly<Record<string, MediaTool>> = { ...libraryTools, ...planTools }

export const isMediaTool = (name: string): boolean => Object.hasOwn(mediaTools, name)

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
    return { ok: true, result: await tool.run(deps, actor, args) }
  } catch (error) {
    if (error instanceof BoardError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}
