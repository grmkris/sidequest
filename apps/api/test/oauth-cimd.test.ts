import { expect, test, vi } from 'vitest'
import { resolveClientMetadata } from '../src/oauth-cimd.ts'

const clientId = 'https://vscode.dev/oauth/client-metadata.json'
const metadata = {
  client_id: clientId,
  client_name: 'VS Code',
  redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
  token_endpoint_auth_method: 'none',
}
const response = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } })

test('fetches a public metadata document with a deadline, no redirects, and no inbound credentials', async () => {
  const fetcher = vi.fn(async () => response(metadata))
  expect(await resolveClientMetadata(clientId, fetcher)).toEqual(metadata)
  expect(fetcher).toHaveBeenCalledWith(clientId, {
    redirect: 'manual',
    signal: expect.any(AbortSignal),
    headers: { accept: 'application/json' },
  })
})

test.each([
  'http://vscode.dev/oauth/client-metadata.json',
  'https://127.0.0.1/client.json',
  'https://vscode.dev.evil.test/oauth/client-metadata.json',
  'https://vscode.dev/oauth/client-metadata.json?url=http://localhost',
  'https://user@vscode.dev/oauth/client-metadata.json',
])('refuses untrusted URL %s before fetching', async (url) => {
  const fetcher = vi.fn()
  await expect(resolveClientMetadata(url, fetcher)).rejects.toThrow('not trusted')
  expect(fetcher).not.toHaveBeenCalled()
})

test.each([
  { ...metadata, client_id: 'https://other.example/client.json' },
  { ...metadata, client_name: '' },
  { ...metadata, redirect_uris: [] },
  { ...metadata, redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] },
  { ...metadata, redirect_uris: ['http://evil.example/cb'] },
  { ...metadata, token_endpoint_auth_method: 'private_key_jwt' },
])('rejects invalid metadata %j', async (body) => {
  await expect(resolveClientMetadata(clientId, async () => response(body))).rejects.toThrow()
})

test('refuses redirects, HTML and an oversized streamed document', async () => {
  for (const reply of [
    new Response(null, { status: 302, headers: { location: 'http://localhost' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    response({ ...metadata, extra: 'x'.repeat(5120) }),
  ])
    await expect(resolveClientMetadata(clientId, async () => reply)).rejects.toThrow()
})

test('respects max-age and no-store rather than persisting arbitrary stale metadata', async () => {
  const id = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
  const fetcher = vi.fn(async () =>
    Response.json({ ...metadata, client_id: id }, { headers: { 'cache-control': 'max-age=60' } }),
  )
  await resolveClientMetadata(id, fetcher)
  await resolveClientMetadata(id, fetcher)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const uncached = vi.fn(async () => response(metadata))
  await resolveClientMetadata(clientId, uncached)
  await resolveClientMetadata(clientId, uncached)
  expect(uncached).toHaveBeenCalledTimes(2)
})
