/** `bun test crew/bin/mcp-oauth.test.ts`: signing a connection in to an MCP server, and keeping its token fresh. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REDIRECT, beginLogin, finishLogin, freshToken, readTokens } from './mcp-oauth.ts'

const SERVER = 'https://mcp.example.test/mcp'
const ISSUER = 'https://auth.example.test'
const CLIENT = { name: 'Sidequest crew: Reel', scope: 'connector offline_access' }

/** The text of a request body the SDK sent: JSON for registration, a form for the token endpoint. */
const bodyText = (init: RequestInit | undefined): Promise<string> => new Response(init?.body).text()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A protected resource and its authorization server, as RFC 9728, RFC 8414 and RFC 7591 describe them. */
function authorizationServer() {
  const forms: Array<Record<string, string>> = []
  let issued = 0
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
          return json({
            resource: SERVER,
            authorization_servers: [ISSUER],
            scopes_supported: ['connector', 'offline_access'],
          })
        if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            registration_endpoint: `${ISSUER}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          })
        if (url.pathname === '/register') {
          const metadata = JSON.parse(await bodyText(init))
          return json({ ...metadata, client_id: 'client-1' }, 201)
        }
        if (url.pathname === '/token') {
          const form = Object.fromEntries(new URLSearchParams(await bodyText(init)))
          forms.push(form)
          issued += 1
          return json({
            access_token: `access-${issued}`,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: `refresh-${issued}`,
          })
        }
        return new Response('not found', { status: 404 })
      },
      { preconnect: () => undefined },
    ),
  )
  return { forms, fetchSpy }
}

let dir = ''
const files = () => ({
  client: join(dir, 'client.json'),
  login: join(dir, 'login.json'),
  token: join(dir, 'token.json'),
  lock: join(dir, 'token.lock'),
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('a login discovers the server, registers once, and exchanges the code with its PKCE verifier', async () => {
  const { forms, fetchSpy } = authorizationServer()
  try {
    const address = new URL(await beginLogin(SERVER, files(), CLIENT))
    expect(address.origin + address.pathname).toBe(`${ISSUER}/authorize`)
    expect(address.searchParams.get('client_id')).toBe('client-1')
    expect(address.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(address.searchParams.get('resource')).toBe(SERVER)
    expect(address.searchParams.get('code_challenge_method')).toBe('S256')
    const state = address.searchParams.get('state')
    expect(state).toMatch(/^[0-9a-f]{24}$/u)

    const elsewhere = await finishLogin(SERVER, files(), CLIENT, `${REDIRECT}?code=c1&state=other`).catch(
      (error: unknown) => error,
    )
    expect(String(elsewhere)).toContain('different login')
    await finishLogin(SERVER, files(), CLIENT, `${REDIRECT}?code=c1&state=${state}`)
    const [exchange] = forms
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c1',
      client_id: 'client-1',
      resource: SERVER,
    })
    // The verifier the token request proves is the one whose challenge the authorization request carried.
    const challenge = createHash('sha256')
      .update(exchange?.code_verifier ?? '')
      .digest('base64url')
    expect(challenge).toBe(address.searchParams.get('code_challenge') ?? '')
    expect(readTokens(files().token) ?? {}).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' })
    expect(existsSync(files().login)).toBe(false)
    expect(JSON.parse(readFileSync(files().client, 'utf8'))).toMatchObject({ client_id: 'client-1' })
  } finally {
    fetchSpy.mockRestore()
  }
})

test('a fresh token is used as it is; one about to expire is refreshed once under the lock', async () => {
  const { forms, fetchSpy } = authorizationServer()
  try {
    const address = new URL(await beginLogin(SERVER, files(), CLIENT))
    await finishLogin(SERVER, files(), CLIENT, `${REDIRECT}?code=c1&state=${address.searchParams.get('state')}`)
    expect(await freshToken(SERVER, files(), CLIENT, 300, 'reel')).toBe('access-1')
    expect(forms).toHaveLength(1)
    // A run that may last longer than the token's hour asks for a new one first.
    const [first, second] = await Promise.all([
      freshToken(SERVER, files(), CLIENT, 7200, 'reel'),
      freshToken(SERVER, files(), CLIENT, 3000, 'reel'),
    ])
    expect(forms.slice(1).map((form) => form.grant_type)).toEqual(['refresh_token'])
    expect(forms[1]).toMatchObject({ refresh_token: 'refresh-1', client_id: 'client-1', resource: SERVER })
    expect([first, second].toSorted()).toEqual(['access-2', 'access-2'])
    expect(existsSync(files().lock)).toBe(false)
  } finally {
    fetchSpy.mockRestore()
  }
})

test('a connection that never signed in says so', async () => {
  const refused = await freshToken(SERVER, files(), CLIENT, 300, 'reel').catch((error: unknown) => error)
  expect(String(refused)).toContain('reel is not connected')
})
