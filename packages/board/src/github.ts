/**
 * GitHub App access for the attester (spec §5): an installation token from the App's key (RS256 JWT via WebCrypto, so
 * it runs in Workers and Node alike), and the check runs of one commit. Read-only.
 */
export interface GitHubApp {
  readonly appId: string
  /** PEM, PKCS#1 ("BEGIN RSA PRIVATE KEY") or PKCS#8; literal "\n" sequences are accepted. */
  readonly privateKeyPem: string
  readonly installationId: string
}

export interface CheckRun {
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly head_sha: string
  readonly app: string | null
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

/** Wraps a PKCS#1 RSAPrivateKey in the PKCS#8 PrivateKeyInfo envelope WebCrypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00]
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octet = [0x04, ...derLength(pkcs1.length), ...pkcs1]
  const body = [...version, ...algorithm, ...octet]
  return new Uint8Array([0x30, ...derLength(body.length), ...body])
}

function pemToDer(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const text = pem.replace(/\\n/g, '\n')
  const pkcs1 = text.includes('BEGIN RSA PRIVATE KEY')
  const b64 = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return { der: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), pkcs1 }
}

const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function appJwt(app: GitHubApp, now: number): Promise<string> {
  const { der, pkcs1 } = pemToDer(app.privateKeyPem)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs1 ? pkcs1ToPkcs8(der) : der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }))
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`
}

const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'sidequest-attester',
  'x-github-api-version': '2022-11-28',
}

export async function installationToken(app: GitHubApp, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const res = await fetch(`https://api.github.com/app/installations/${app.installationId}/access_tokens`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { ...HEADERS, authorization: `Bearer ${await appJwt(app, now)}` },
  })
  if (!res.ok) throw new Error(`GitHub App token: HTTP ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

/** `owner/repo` from a GitHub URL, or undefined for anything else. */
export function repoSlug(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  return m?.[1]
}

export async function checkRuns(token: string | undefined, slug: string, sha: string): Promise<CheckRun[]> {
  const res = await fetch(`https://api.github.com/repos/${slug}/commits/${sha}/check-runs?per_page=100`, {
    headers: token === undefined ? HEADERS : { ...HEADERS, authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GitHub check runs: HTTP ${res.status}`)
  const body = (await res.json()) as {
    check_runs: Array<{
      name: string
      status: string
      conclusion: string | null
      head_sha: string
      app?: { slug?: string }
    }>
  }
  return body.check_runs.map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    head_sha: r.head_sha,
    app: r.app?.slug ?? null,
  }))
}
