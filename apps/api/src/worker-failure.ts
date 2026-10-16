import { Cause, Effect } from 'effect'
import { agentFailureReply, DirectoryError, readOnlyHostedTools, SessionError, TenantError } from '@sidequest/board'
import type { BoardReply } from './board.ts'
import { DirectoryCallError } from './directory.ts'
import { TelegramError } from './telegram.ts'

/** Explicit Worker refusals keep their code; unexpected errors use the shared safe reply/log boundary. */
export const workerFailure = (e: unknown, tool?: string): Extract<BoardReply, { ok: false }> =>
  e instanceof TenantError ||
  e instanceof SessionError ||
  e instanceof DirectoryError ||
  e instanceof DirectoryCallError ||
  e instanceof TelegramError
    ? {
        ok: false,
        code: e.code,
        message: e.message,
        ...(e instanceof DirectoryCallError && e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
      }
    : agentFailureReply(
        e,
        'The request could not be completed',
        undefined,
        tool !== undefined && readOnlyHostedTools.has(tool) ? 'unavailable' : 'error',
        tool !== undefined && readOnlyHostedTools.has(tool) ? 'read' : 'same-key',
      )

/** Durable Object transport failures also use read retry guidance, rather than escaping as a generic HTTP 500. */
export const readFailureBoundary =
  (tool: string) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    readOnlyHostedTools.has(tool)
      ? work.pipe(Effect.catchCause((cause) => Effect.succeed(workerFailure(Cause.squash(cause), tool))))
      : work
