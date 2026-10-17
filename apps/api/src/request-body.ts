/** Includes a 1 MiB image encoded as base64 plus its REST/MCP envelope. */
export const MAX_API_BODY_BYTES = 2 * 1024 * 1024
export const MAX_TELEGRAM_BODY_BYTES = 64 * 1024

type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 | 503; message: string }

/** Count actual streamed bytes before decoding; Content-Length alone cannot bound a chunked upload. */
export async function readRequestBody(source: unknown, limit: number): Promise<BodyRead> {
  if (!(source instanceof Request)) return { ok: false, status: 503, message: 'Request body unavailable' }
  const tooLarge = { ok: false, status: 413, message: 'Request body is too large' } as const
  if (Number(source.headers.get('content-length')) > limit) {
    await source.body?.cancel().catch(() => {})
    return tooLarge
  }
  if (source.body === null) return { ok: true, bytes: new Uint8Array() }
  const reader = source.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        return tooLarge
      }
      chunks.push(next.value)
    }
  } catch {
    return { ok: false, status: 400, message: 'Request body could not be read' }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}
