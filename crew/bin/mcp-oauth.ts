/**
 * OAuth for any MCP server a crew member or hosted hirer uses, through the MCP TypeScript SDK's client flow: protected
 * resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591),
 * authorization code with PKCE, and refresh. The operator approves once in a browser; the browser lands on a loopback
 * address nothing listens on, and that address is pasted back. Each connection keeps its files where its caller says;
 * nothing here knows about members, personas or which server it is.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Schema } from 'effect'
import {
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { secretFile } from './hosted-mcp.ts'

/**
 * Where the operator's browser lands after consent: nothing listens there, so its address is pasted back. An operator
 * browser shared with this machine's agent can land on an HTTPS page instead (`CREW_OAUTH_REDIRECT`), whose address the
 * agent reads from the tab; the code in it is useless without this machine's PKCE verifier.
 */
export const REDIRECT = process.env.CREW_OAUTH_REDIRECT || 'http://127.0.0.1:8765/callback'

/** One connection's files: its registered client, a pending login, its tokens and the refresh lock. */
export interface ConnectionFiles {
  client: string
  login: string
  token: string
  lock: string
}

/** Stored tokens: the server's reply as the SDK hands it over, and when the access token expires (Unix seconds). */
export type StoredTokens = OAuthTokens & { expires_at: number }

/** A JSON file decoded by `decode`, or undefined when there is none. */
const readFile = <T>(path: string, decode: (value: unknown) => T): T | undefined =>
  existsSync(path) ? decode(JSON.parse(readFileSync(path, 'utf8'))) : undefined

const Expiry = Schema.Struct({ expires_at: Schema.Number })

export const readTokens = (path: string): StoredTokens | undefined =>
  readFile(path, (value) => ({ ...OAuthTokensSchema.parse(value), ...Schema.decodeUnknownSync(Expiry)(value) }))

/** A pending login: the PKCE verifier and the state the authorization request carried. */
const PendingLogin = Schema.Struct({
  verifier: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
})
type PendingLogin = typeof PendingLogin.Type

const readPending = (path: string): PendingLogin => readFile(path, Schema.decodeUnknownSync(PendingLogin)) ?? {}

/** The SDK's view of one connection's files. A login's authorization URL is kept here for the caller to print. */
class FileProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined

  constructor(
    private readonly files: ConnectionFiles,
    private readonly client: { name: string; scope: string },
  ) {}

  get redirectUrl(): string {
    return REDIRECT
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.client.name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.client.scope,
    }
  }

  #pending(): PendingLogin {
    return readPending(this.files.login)
  }

  state(): string {
    const state = randomBytes(12).toString('hex')
    secretFile(this.files.login, { ...this.#pending(), state })
    return state
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readFile(
      this.files.client,
      // SAFETY: the file holds exactly what saveClientInformation wrote, the SDK's own value with its issuer stamp,
      // which a strict schema would strip.
      (value) => value as OAuthClientInformationMixed,
    )
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    secretFile(this.files.client, information)
  }

  tokens(): OAuthTokens | undefined {
    return readTokens(this.files.token)
  }

  saveTokens(tokens: OAuthTokens): void {
    secretFile(this.files.token, { ...tokens, expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600) })
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url
  }

  saveCodeVerifier(verifier: string): void {
    secretFile(this.files.login, { ...this.#pending(), verifier })
  }

  codeVerifier(): string {
    const { verifier } = this.#pending()
    if (verifier === undefined) throw new Error('start the login first')
    return verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') rmSync(this.files.client, { force: true })
    if (scope === 'all' || scope === 'tokens') rmSync(this.files.token, { force: true })
    if (scope === 'all' || scope === 'verifier') rmSync(this.files.login, { force: true })
  }
}

/**
 * Starts a login: discovers the server's authorization server, registers the client when it has none, and returns the
 * address the operator opens to approve. An earlier connection's tokens give way to the new consent.
 */
export async function beginLogin(
  server: string,
  files: ConnectionFiles,
  client: { name: string; scope: string },
): Promise<string> {
  const provider = new FileProvider(files, client)
  provider.invalidateCredentials('tokens')
  provider.invalidateCredentials('verifier')
  await auth(provider, { serverUrl: server, scope: client.scope })
  if (provider.authorizationUrl === undefined) throw new Error(`${server} answered no authorization address`)
  return provider.authorizationUrl.toString()
}

/** Finishes a login from the address the browser landed on, and saves the tokens. */
export async function finishLogin(
  server: string,
  files: ConnectionFiles,
  client: { name: string; scope: string },
  landed: string,
): Promise<void> {
  const url = new URL(landed)
  const refused = url.searchParams.get('error')
  if (refused !== null) throw new Error(`consent refused: ${refused}`)
  const provider = new FileProvider(files, client)
  const { state } = readPending(files.login)
  if (state === undefined || url.searchParams.get('state') !== state)
    throw new Error('that address is from a different login; start again')
  const code = url.searchParams.get('code')
  if (code === null) throw new Error('that address carries no authorization code')
  await auth(provider, { serverUrl: server, authorizationCode: code })
  rmSync(files.login, { force: true })
}

/** One refresh at a time per connection: a refresh token works once, and replaying it revokes the grant. */
export async function withTokenLock<T>(lock: string, label: string, work: () => Promise<T>): Promise<T> {
  for (let waited = 0; ; waited += 250) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // A lock older than a minute outlived its holder (a refresh takes seconds); a younger one is still in use.
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0)
      if (age > 60_000) rmSync(lock, { recursive: true, force: true })
      else if (waited > 30_000) throw new Error(`${label}: its token lock has been held for 30 s`)
      else await Bun.sleep(250)
    }
  }
  try {
    return await work()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** An access token that stays valid for at least `minSeconds`, refreshed under the lock when it would not. */
export async function freshToken(
  server: string,
  files: ConnectionFiles,
  client: { name: string; scope: string },
  minSeconds: number,
  label: string,
): Promise<string> {
  return withTokenLock(files.lock, label, async () => {
    const stored = readTokens(files.token)
    if (stored === undefined) throw new Error(`${label} is not connected to ${server}; run its login`)
    if (stored.expires_at - Math.floor(Date.now() / 1000) > minSeconds) return stored.access_token
    const result = await auth(new FileProvider(files, client), { serverUrl: server })
    const renewed = readTokens(files.token)
    if (result !== 'AUTHORIZED' || renewed === undefined)
      throw new Error(`${label}: ${server} wants a new login; run its login`)
    return renewed.access_token
  })
}
