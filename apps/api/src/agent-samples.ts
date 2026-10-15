/** Sample images share avatar storage, but never put image bytes in the operation journal. */
import { AgentStore, BoardError, type Sql } from '@sidequest/board'
import { Schema } from 'effect'
import { identifyAvatar, MAX_AVATAR_BYTES, storeAvatar, type AvatarBucket } from './avatars.ts'
import { profileOrigin } from './profiles.ts'

export const MAX_SAMPLE_BASE64 = 4 * Math.ceil(MAX_AVATAR_BYTES / 3)
const SampleInput = Schema.Struct({
  image: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SAMPLE_BASE64)),
})

function sampleBytes(input: unknown): Uint8Array {
  try {
    const { image } = Schema.decodeUnknownSync(SampleInput)(input, { onExcessProperty: 'error' })
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) throw new Error('Invalid base64')
    return Uint8Array.from(atob(image), (char) => char.charCodeAt(0))
  } catch {
    throw new BoardError('invalid', 'Sample image must be base64, decoding to at most 1 MiB of PNG, JPEG or WebP')
  }
}

export async function uploadSample(input: {
  sql: Sql
  now: () => number
  origin: string
  boardId: string
  bucket: AvatarBucket | undefined
  agentId: string
  key: string
  args: unknown
}): Promise<{ url: string }> {
  const bytes = sampleBytes(input.args)
  const stored = await identifyAvatar(bytes, 'samples')
  const agents = new AgentStore(input.sql, input.now)
  if (input.sql.atomic === undefined) throw new Error('Sample uploads require atomic storage')
  const operation = input.sql.atomic(() => {
    const started = agents.begin(input.agentId, input.key, input.boardId, 'upload_sample', { key: stored.key })
    const day = Math.floor(started.created_at / 86400) * 86400
    const count = input.sql.all<{ total: number }>(
      "SELECT COUNT(*) AS total FROM agent_operations WHERE agent_id=? AND tool='upload_sample' AND created_at>=? AND created_at<?",
      input.agentId,
      day,
      day + 86400,
    )[0]!.total
    if (count > 40) throw new BoardError('conflict', 'Sample uploads are limited to 40 per agent per UTC day')
    return started
  })
  const done = agents.step<{ url: string }>(operation.id, 'sample:done')
  if (done !== undefined) return done
  if (input.bucket === undefined) throw new BoardError('unavailable', 'Sample storage is unavailable')
  await storeAvatar(input.bucket, bytes, 'samples')
  const result = { url: `${profileOrigin(input.origin)}/${stored.key}` }
  return input.sql.atomic(() => {
    agents.saveOperation(operation.id, 'sending')
    agents.saveOperation(operation.id, 'confirmed', { result })
    return agents.freezeStep(operation.id, 'sample:done', result)
  })
}
