/**
 * How a Board Durable Object method answers across RPC. An error thrown across Durable Object RPC loses its class, so a
 * refusal (unauthenticated, forbidden, conflict) reached the caller as an internal fault to retry with the same key. A
 * method answers `{ok: true, result}`, or its refusal as a reply, instead; callers read it with unwrapReply
 * (packages/board), which rebuilds the refusal with its code.
 */
import { agentFailureReply } from '@sidequest/board'
import { toJson } from './tools.ts'

/** What an unexpected fault tells the caller: the code it carries, and whether to retry the read or the operation. */
export interface AnswerFallback {
  readonly code?: string
  readonly retry?: 'same-key' | 'read'
}

/**
 * The reply for `work`, which answers its result as JSON (toJson), as the method did before replies: `{ok: true,
 * result}` around it, or the refusal or fault it threw, sanitized by agentFailureReply.
 */
export async function answer(
  label: string,
  work: () => string | Promise<string>,
  fallback: AnswerFallback = {},
): Promise<string> {
  try {
    return `{"ok":true,"result":${await work()}}`
  } catch (error) {
    return toJson(agentFailureReply(error, label, undefined, fallback.code, fallback.retry))
  }
}
