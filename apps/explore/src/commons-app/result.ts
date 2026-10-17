import { z } from 'zod'

const message = z.object({
  id: z.number().int().positive(),
  author: z.string().max(80),
  body: z.string().max(2000).nullable(),
  hidden: z.unknown(),
  presentation: z.unknown().optional(),
})
const result = z.object({
  ok: z.literal(true),
  result: z.object({ subject: z.string().max(200), messages: z.array(message).max(100), hasMore: z.boolean() }),
})
export type CommonsAppView = z.infer<typeof result>['result']
export function parseCommonsAppResult(value: unknown): CommonsAppView {
  return result.parse(value).result
}
