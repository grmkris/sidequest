import { nowSeconds } from '../time.ts'
import { Effect, Option, Schema } from 'effect'
import { Invalid } from '../errors.ts'
import { postEvents } from '../feed.ts'
import { Address } from '../schema/ids.ts'
import type { PostMessageInput } from '../schema/messages.ts'
import { CommonsSql, Directory, FeedSink } from '../services.ts'
import { sqlEffect } from '../sql/effects.ts'
import { enabled } from '../roles/holders.ts'
import { postingAccess } from './access.ts'
import { insertPost } from './insert.ts'
import { subjectContext } from './subject.ts'
import { mentionTokens, normalizeText } from './text.ts'
import type { Presentation } from '@sidequest/sdk/commons-ui'
import { normalizePresentation } from '@sidequest/sdk/commons-ui/openui'

export const postMessage = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof PostMessageInput.Type,
) {
  yield* enabled()
  const body = yield* normalizeText(input.body)
  const presentation: Presentation | null =
    input.presentation === undefined
      ? null
      : yield* Effect.try({
          try: () => normalizePresentation(input.presentation),
          catch: (error) => new Invalid({ message: error instanceof Error ? error.message : 'Invalid presentation' }),
        })
  const context = yield* subjectContext(input.subject)
  const access = yield* postingAccess(caller, context.participants)
  const directory = yield* Directory
  const tokens = mentionTokens(body)
  if (tokens.length > 5) return yield* new Invalid({ message: 'At most five unique mentions' })
  const resolved = yield* directory.resolve(tokens)
  const mentions = tokens.map((token) => ({
    token,
    address:
      Option.getOrNull(Schema.decodeUnknownOption(Address)(token)) ??
      resolved.find((entry) => entry.token.toLowerCase() === token.toLowerCase())?.address ??
      null,
  }))
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  const result = yield* sqlEffect(() =>
    sql.transaction((tx) =>
      insertPost(tx, {
        address: access.address,
        input: { ...input, body },
        mentions,
        people: context.participants,
        roles: access.roles,
        stake: access.stake,
        now,
        presentation,
      }),
    ),
  )
  const events = postEvents(result.message, context.participants, access.config.moderator, result.parentAuthor)
  const feed = yield* FeedSink
  yield* feed.write(events)
  return { message: result.message, notified: events.length }
})
