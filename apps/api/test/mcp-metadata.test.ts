import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  catalogReply,
  MCP_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  registryManifest,
  registryProofReply,
  serverCard,
  serverCardReply,
} from '../src/mcp-metadata.ts'
import registryProof from '../src/mcp-registry-proof.json' with { type: 'json' }

const origin = 'https://dev.sidequest.exchange'

describe('public MCP metadata', () => {
  it('shares registry identity, version, description, icons and repository with the production manifest', () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../../../server.json', import.meta.url), 'utf8'))
    expect(manifest).toEqual(registryManifest('https://sidequest.exchange'))
    const card = serverCard(origin)
    expect(card).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: 'exchange.sidequest/sidequest',
      title: 'Sidequest',
      version: '2.0.0',
      icons: [{ src: `${origin}/icons/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] }],
      remotes: [
        {
          type: 'streamable-http',
          url: `${origin}/mcp`,
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION, ...MCP_LEGACY_PROTOCOL_VERSIONS],
        },
        {
          type: 'streamable-http',
          url: `${origin}/mcp/directory`,
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION, ...MCP_LEGACY_PROTOCOL_VERSIONS],
          authentication: { type: 'none' },
        },
      ],
    })
    expect(card.description.length).toBeLessThanOrEqual(100)
    expect(card).not.toHaveProperty('tools')
    expect(card).not.toHaveProperty('capabilities')
    expect(card).not.toHaveProperty('headers')
  })

  it('uses the exact tenant resource while keeping stage-specific URLs out of the production manifest', () => {
    expect(serverCard(origin, '/b/my-team').remotes.map((remote) => remote.url)).toEqual([
      `${origin}/b/my-team/mcp`,
      `${origin}/b/my-team/mcp/directory`,
    ])
    expect(JSON.stringify(registryManifest('https://sidequest.exchange'))).not.toContain('dev.sidequest.exchange')
  })

  it('serves public cacheable JSON with the card media type and browser discovery headers', () => {
    const reply = serverCardReply(origin, '', {})
    expect(reply.status).toBe(200)
    expect(reply.headers).toMatchObject({
      'content-type': 'application/mcp-server-card+json',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET',
      'access-control-allow-headers': 'Content-Type, If-None-Match',
      'access-control-expose-headers': 'ETag',
    })
    expect(reply.headers.etag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(reply.body).toBe(JSON.stringify(serverCard(origin)))
  })

  it('revalidates unchanged cards for strong, weak, list and wildcard validators but separates tenant representations', () => {
    const publicReply = serverCardReply(origin, '', {})
    const etag = publicReply.headers.etag!
    for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const reply = serverCardReply(origin, '', { 'if-none-match': validator })
      expect(reply.status).toBe(304)
      expect(reply.body).toBe('')
      expect(reply.headers.etag).toBe(etag)
    }
    expect(serverCardReply(origin, '/b/my-team', { 'if-none-match': etag }).status).toBe(200)
  })

  it('catalogs only the public card and never lists tenant, tool or authority data', () => {
    const reply = catalogReply(origin, {})
    expect(reply.headers['content-type']).toBe('application/ai-catalog+json')
    expect(JSON.parse(reply.body)).toEqual({
      specVersion: '1.0',
      entries: [
        {
          identifier: 'urn:air:sidequest.exchange:mcp:sidequest',
          type: 'application/mcp-server-card+json',
          url: `${origin}/mcp/server-card`,
        },
      ],
    })
    expect(catalogReply(origin, { 'if-none-match': reply.headers.etag }).status).toBe(304)
  })

  it('publishes only a valid Ed25519 public proof, with no private registry credentials', () => {
    const reply = registryProofReply(registryProof.proof)
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(reply.body).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/)
    expect(reply.body).not.toContain('PRIVATE')
  })
})
