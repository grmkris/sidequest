/**
 * `add_media({ files: [{ sourceUrl }] })`: a render already at a URL streams into R2 without passing through the
 * caller (ADR-0029). Only https URLs on the stage's `media.pullHosts`, no redirects, a declared length of at most 1 GiB.
 * With the file's sha256 given, one fetch stores it and R2 checks the bytes; without it, a first fetch hashes the body
 * and a second one stores it under that hash.
 */
import { BoardError } from '@sidequest/board'
import { SHA256 } from './rows.ts'
import { checksumHex, MAX_MEDIA_BYTES, type MediaBucket } from './serve.ts'

/** Workers' streaming digest; Node has none, so the pull path runs in the Worker and its workerd test. */
interface WorkersCrypto {
  readonly DigestStream?: new (
    algorithm: 'SHA-256',
  ) => WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> }
}

export interface PullDeps {
  readonly bucket: MediaBucket
  readonly hosts: readonly string[]
  readonly fetch: typeof fetch
}

export interface Pulled {
  readonly sha256: string
  readonly bytes: number
  readonly type: string
}

function allowed(raw: string, hosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BoardError('invalid', 'sourceUrl must be an https URL')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new BoardError('invalid', 'sourceUrl must be an https URL without credentials')
  if (!hosts.includes(url.hostname.toLowerCase()))
    throw new BoardError('forbidden', `media is pulled only from ${hosts.join(', ') || 'no host on this stage'}`)
  return url
}

async function open(deps: PullDeps, url: URL): Promise<{ body: ReadableStream; bytes: number; type: string }> {
  const response = await deps.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000) })
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel()
    throw new BoardError('invalid', `sourceUrl answered ${response.status}, not the file`)
  }
  const bytes = Number(response.headers.get('content-length') ?? Number.NaN)
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MEDIA_BYTES) {
    await response.body.cancel()
    throw new BoardError('invalid', 'sourceUrl must answer with a Content-Length of at most 1 GiB')
  }
  const type = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase()
  return { body: response.body, bytes, type }
}

async function digest(body: ReadableStream): Promise<string> {
  // SAFETY: workerd's crypto carries DigestStream beside the WebCrypto members; elsewhere it is absent.
  const { DigestStream } = crypto as typeof crypto & WorkersCrypto
  if (DigestStream === undefined) throw new BoardError('unavailable', 'pulling media needs the Workers runtime')
  const sink = new DigestStream('SHA-256')
  await body.pipeTo(sink)
  return checksumHex(await sink.digest)!
}

export async function pullMedia(deps: PullDeps, raw: string, expected?: string): Promise<Pulled> {
  const url = allowed(raw, deps.hosts)
  if (expected !== undefined && !SHA256.test(expected)) throw new BoardError('invalid', 'sha256 must be 64 hex digits')
  let sha256 = expected
  if (sha256 === undefined) sha256 = await digest((await open(deps, url)).body)
  const key = `files/${sha256}`
  const present = await deps.bucket.head(key)
  if (present !== null)
    return { sha256, bytes: present.size, type: present.httpMetadata?.contentType ?? 'application/octet-stream' }
  const opened = await open(deps, url)
  try {
    await deps.bucket.put(key, opened.body, { sha256, httpMetadata: { contentType: opened.type } })
  } catch {
    throw new BoardError('invalid', 'the file at sourceUrl does not match its sha256; nothing was stored')
  }
  const stored = await deps.bucket.head(key)
  if (stored === null || stored.size !== opened.bytes || checksumHex(stored.checksums.sha256) !== sha256)
    throw new BoardError('unavailable', 'storage did not confirm the pulled file; try again')
  return { sha256, bytes: stored.size, type: opened.type }
}
