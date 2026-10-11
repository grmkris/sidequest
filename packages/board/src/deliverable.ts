/**
 * Deliverables anywhere (ADR-0006): the board coordinates and hosts nothing. A worker brings its own hosting and
 * submits a small descriptor of where the work is; the descriptor's hash is what `core.submit` records on-chain.
 * The board checks the descriptor once at submit (an advisory "submission check") and keeps no copy of the work.
 */
import { type Hex, keccak256, stringToHex } from 'viem'
import { canonicalJson } from './terms.ts'

export const DELIVERABLE_KINDS = ['git', 'patch', 'artifact', 'url', 'onchain'] as const
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]

/** What an offer accepts, frozen into its terms. Absent means `{ accepts: ['git'] }`. */
export interface DeliverableSpec {
  accepts: readonly DeliverableKind[]
  /** Free text: where and how the creator wants it (e.g. "PR-able against github.com/o/r at <sha>"). */
  target?: string
}

export type Deliverable =
  /** A commit on any git host. */
  | { kind: 'git'; url: string; ref: string; sha: string }
  /** A git patch or bundle hosted anywhere, applying to `base`. */
  | { kind: 'patch'; url: string; sha256: string; base: string }
  /** A file: video, image, report, dataset. */
  | { kind: 'artifact'; url: string; sha256: string; mediaType: string; name: string }
  /** A deployed site. */
  | { kind: 'url'; url: string }
  /** A transaction or a contract. */
  | { kind: 'onchain'; chainId: number; txHash?: string; address?: string }

export const DEFAULT_SPEC: DeliverableSpec = { accepts: ['git'] }

export class DeliverableError extends Error {}

const isSha1 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
const isSha256 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
const str = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 2048

/** A DNS name, not an IP literal, localhost or a private-network suffix. */
export function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return false
  if (!host.includes('.')) return false
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|private)$/.test(host)
}

/** The board fetches these once at submit, so only public https (or ipfs://, through a public gateway). */
export function fetchable(url: unknown): url is string {
  if (!str(url)) return false
  if (url.startsWith('ipfs://')) return /^ipfs:\/\/[A-Za-z0-9]{20,}(\/[^\s]*)?$/.test(url)
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.username === '' && u.password === '' && publicHost(u.hostname)
  } catch {
    return false
  }
}

/** Validates a descriptor from an untrusted caller; unknown fields are dropped so the hash covers only what it says. */
export function parseDeliverable(raw: unknown): Deliverable {
  if (raw === null || typeof raw !== 'object') throw new DeliverableError('deliverable must be an object with a kind')
  const d = raw as Record<string, unknown>
  switch (d.kind) {
    case 'git':
      if (!str(d.url)) throw new DeliverableError('git: url is required (any git host)')
      if (!str(d.ref)) throw new DeliverableError('git: ref (branch or tag) is required')
      if (!isSha1(d.sha)) throw new DeliverableError('git: sha must be a full 40-character commit SHA')
      return { kind: 'git', url: d.url, ref: d.ref, sha: d.sha }
    case 'patch':
      if (!fetchable(d.url)) throw new DeliverableError('patch: url must be a public https URL or ipfs://')
      if (!isSha256(d.sha256)) throw new DeliverableError('patch: sha256 must be 64 lowercase hex characters')
      if (!isSha1(d.base)) throw new DeliverableError('patch: base must be the full commit SHA it applies to')
      return { kind: 'patch', url: d.url, sha256: d.sha256, base: d.base }
    case 'artifact':
      if (!fetchable(d.url)) throw new DeliverableError('artifact: url must be a public https URL or ipfs://')
      if (!isSha256(d.sha256)) throw new DeliverableError('artifact: sha256 must be 64 lowercase hex characters')
      if (!str(d.mediaType)) throw new DeliverableError('artifact: mediaType is required')
      if (!str(d.name)) throw new DeliverableError('artifact: name is required')
      return { kind: 'artifact', url: d.url, sha256: d.sha256, mediaType: d.mediaType, name: d.name }
    case 'url':
      if (!fetchable(d.url) || String(d.url).startsWith('ipfs://'))
        throw new DeliverableError('url: must be a public https URL')
      return { kind: 'url', url: d.url as string }
    case 'onchain': {
      if (typeof d.chainId !== 'number' || !Number.isSafeInteger(d.chainId) || d.chainId <= 0)
        throw new DeliverableError('onchain: chainId is required')
      const tx = d.txHash === undefined ? undefined : String(d.txHash)
      const addr = d.address === undefined ? undefined : String(d.address)
      if (tx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(tx))
        throw new DeliverableError('onchain: txHash must be a 0x-prefixed 32-byte hash')
      if (addr !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(addr))
        throw new DeliverableError('onchain: address must be a 0x-prefixed 20-byte address')
      if (tx === undefined && addr === undefined)
        throw new DeliverableError('onchain: give a txHash, an address, or both')
      return {
        kind: 'onchain',
        chainId: d.chainId,
        ...(tx === undefined ? {} : { txHash: tx.toLowerCase() }),
        ...(addr === undefined ? {} : { address: addr.toLowerCase() }),
      }
    }
    default:
      throw new DeliverableError(`deliverable kind must be one of ${DELIVERABLE_KINDS.join(', ')}`)
  }
}

/**
 * The hash `core.submit` records. A git deliverable hashes as the legacy `{repo, branch, sha}` triple, so every
 * earlier submission, evidence statement and dispute bundle keeps matching; every other kind hashes its descriptor.
 */
export function deliverableHash(d: Deliverable): Hex {
  const body = d.kind === 'git' ? { repo: d.url, branch: d.ref, sha: d.sha } : d
  return keccak256(stringToHex(canonicalJson(body)))
}

/** The legacy columns: filled for git, empty for every other kind. */
export function legacyColumns(d: Deliverable): { repo: string; branch: string; sha: string } {
  return d.kind === 'git' ? { repo: d.url, branch: d.ref, sha: d.sha } : { repo: '', branch: '', sha: '' }
}

export function specOf(terms: { deliverable?: DeliverableSpec }): DeliverableSpec {
  return terms.deliverable ?? DEFAULT_SPEC
}

export function validateSpec(spec: DeliverableSpec): string | undefined {
  if (!Array.isArray(spec.accepts) || spec.accepts.length === 0) return 'accepts must list at least one kind'
  if (spec.accepts.some((k) => !DELIVERABLE_KINDS.includes(k)))
    return `accepted kinds are ${DELIVERABLE_KINDS.join(', ')}`
  if (new Set(spec.accepts).size !== spec.accepts.length) return 'accepts lists a kind twice'
  if (spec.target !== undefined && (typeof spec.target !== 'string' || spec.target.length > 500))
    return 'target is text of at most 500 characters'
  return undefined
}

// -------------------------------------------------------------------------------------------------
// The submission check: fetched once, recorded, nothing kept.
// -------------------------------------------------------------------------------------------------

export interface DeliverableCheck {
  /** true: verified; false: checked and wrong; null: could not be checked (unknown host, unreachable, other chain). */
  ok: boolean | null
  detail: string
  checkedAt: number
}

export interface CheckDeps {
  fetch: typeof fetch
  now: () => number
  /** A reader for a chain the board has an RPC for; undefined for any other chain. */
  chain: (chainId: number) =>
    | {
        getTransactionReceipt(a: { hash: Hex }): Promise<{ status: 'success' | 'reverted' }>
        getCode(a: { address: Hex }): Promise<Hex | undefined>
      }
    | undefined
  /**
   * A token for GitHub's API (the board's GitHub App installation), so the commit check is not one of the 60
   * unauthenticated calls an hour GitHub allows the Worker's shared egress address. Absent: unauthenticated.
   */
  githubToken?: () => Promise<string>
}

export const MAX_FETCH_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = 10_000
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

const gatewayUrl = (url: string) => (url.startsWith('ipfs://') ? IPFS_GATEWAY + url.slice('ipfs://'.length) : url)

async function fetchCapped(
  deps: CheckDeps,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; bytes: Uint8Array | null; tooLarge: boolean }> {
  const res = await deps.fetch(gatewayUrl(url), {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
  })
  if (!res.ok) return { status: res.status, bytes: null, tooLarge: false }
  return { status: res.status, ...(await readCapped(res, MAX_FETCH_BYTES)) }
}

/**
 * A response body of at most `max` bytes. Past the cap, `fail` gives no bytes and `tooLarge` (a declared length over
 * the cap fails before reading); `truncate` keeps the first `max` bytes, enough for a page's head.
 */
export async function readCapped(
  res: Response,
  max: number,
  overflow: 'fail' | 'truncate' = 'fail',
): Promise<{ bytes: Uint8Array | null; tooLarge: boolean }> {
  if (res.body === null) return { bytes: null, tooLarge: false }
  if (overflow === 'fail' && Number(res.headers.get('content-length') ?? 0) > max) {
    void res.body.cancel().catch(() => {})
    return { bytes: null, tooLarge: true }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > max) {
      void reader.cancel().catch(() => {})
      if (overflow === 'fail') return { bytes: null, tooLarge: true }
      chunks.push(value.subarray(0, max - size))
      size = max
      break
    }
    size += value.byteLength
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return { bytes: out, tooLarge: false }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `https://host/owner/repo(.git)` → the host's public commit API, for the hosts that have one. */
export function commitApi(url: string, sha: string): { host: string; api: string } | undefined {
  let u: URL
  try {
    u = new URL(url.replace(/^git@([^:]+):/, 'https://$1/'))
  } catch {
    return undefined
  }
  const path = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  const host = u.hostname.toLowerCase()
  if (host === 'github.com') {
    const [o, r] = path.split('/')
    return o && r ? { host, api: `https://api.github.com/repos/${o}/${r}/commits/${sha}` } : undefined
  }
  if (host === 'gitlab.com') {
    return path.includes('/')
      ? { host, api: `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}/repository/commits/${sha}` }
      : undefined
  }
  if (host === 'codeberg.org' || host === 'gitea.com') {
    const [o, r] = path.split('/')
    return o && r ? { host, api: `https://${host}/api/v1/repos/${o}/${r}/git/commits/${sha}` } : undefined
  }
  return undefined
}

/** Checks a deliverable once. Never throws: failures are recorded as a result. */
export async function checkDeliverable(d: Deliverable, deps: CheckDeps): Promise<DeliverableCheck> {
  const done = (ok: boolean | null, detail: string): DeliverableCheck => ({ ok, detail, checkedAt: deps.now() })
  try {
    switch (d.kind) {
      case 'git': {
        const api = commitApi(d.url, d.sha)
        if (api === undefined)
          return done(null, 'unverified host: the board checks github.com, gitlab.com, codeberg.org and gitea.com')
        // Without a token the check still runs, just unauthenticated.
        const token =
          api.host === 'github.com' && deps.githubToken !== undefined
            ? await deps.githubToken().catch(() => undefined)
            : undefined
        const res = await deps.fetch(api.api, {
          headers: {
            accept: 'application/json',
            'user-agent': 'sidequest-board',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        void res.body?.cancel().catch(() => {})
        if (res.status === 200) return done(true, `commit ${d.sha.slice(0, 12)} exists on ${api.host}`)
        if (res.status === 404 || res.status === 422)
          return done(false, `no commit ${d.sha.slice(0, 12)} in that repository on ${api.host} (or it is private)`)
        const limited = res.headers.get('x-ratelimit-remaining') === '0'
        return done(null, `${api.host} answered ${res.status}${limited ? ' (rate limited)' : ''}`)
      }
      case 'patch':
      case 'artifact': {
        const r = await fetchCapped(deps, d.url)
        if (r.tooLarge) return done(null, 'larger than 25 MB: not hashed by the board')
        if (r.bytes === null) return done(false, `fetch failed with HTTP ${r.status}`)
        const got = await sha256Hex(r.bytes)
        return got === d.sha256
          ? done(true, `sha256 matches (${r.bytes.byteLength} bytes)`)
          : done(false, `sha256 mismatch: the file hashes to ${got.slice(0, 16)}…`)
      }
      case 'url': {
        const r = await fetchCapped(deps, d.url)
        if (r.tooLarge) return done(true, 'HTTP 200 (page larger than 25 MB, not hashed)')
        if (r.bytes === null) return done(false, `HTTP ${r.status}`)
        return done(true, `HTTP 200, page sha256 ${(await sha256Hex(r.bytes)).slice(0, 16)}… at submit`)
      }
      case 'onchain': {
        const chain = deps.chain(d.chainId)
        if (chain === undefined) return done(null, `the board has no RPC for chain ${d.chainId}`)
        const found: string[] = []
        const wrong: string[] = []
        if (d.txHash !== undefined) {
          const receipt = await chain.getTransactionReceipt({ hash: d.txHash as Hex }).catch(() => undefined)
          if (receipt === undefined) wrong.push('transaction not found')
          else if (receipt.status === 'success') found.push('transaction succeeded')
          else wrong.push('transaction reverted')
        }
        if (d.address !== undefined) {
          const code = await chain.getCode({ address: d.address as Hex }).catch(() => undefined)
          if (code === undefined || code === '0x') wrong.push('no contract code at the address')
          else found.push('contract code at the address')
        }
        return done(wrong.length === 0, [...wrong, ...found].join('; '))
      }
    }
  } catch (e) {
    // The check is public advisory output; a fetch or RPC error's text can name a provider URL, so give its class only.
    return done(
      null,
      `could not check (${e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'error'})`,
    )
  }
}
