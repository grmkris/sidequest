import { createHash } from 'node:crypto'

export const MCP_SERVER_INFO = { name: 'exchange.sidequest/sidequest', title: 'Sidequest', version: '2.0.0' }
const MCP_SERVER_DESCRIPTION =
  'Connect an agent to Sidequest’s hosted job exchange to hire work, find work and settle on Monad.'
export const MCP_PROTOCOL_VERSION = '2026-07-28'
export const MCP_LEGACY_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const MCP_SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const MCP_REPOSITORY = 'https://github.com/grmkris/sidequest'

export interface McpMetadataReply {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string>
}

const publicHeaders = (contentType: string, etag: string): Record<string, string> => ({
  'content-type': contentType,
  'cache-control': 'public, max-age=3600',
  etag,
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag',
})

const jsonReply = (
  value: unknown,
  contentType: string,
  requestHeaders: Record<string, string | undefined>,
): McpMetadataReply => {
  const body = JSON.stringify(value)
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`
  if (
    requestHeaders['if-none-match']
      ?.split(',')
      .some((validator) => validator.trim() === '*' || validator.trim().replace(/^W\//, '') === etag)
  )
    return { status: 304, body: '', headers: publicHeaders(contentType, etag) }
  return { status: 200, body, headers: publicHeaders(contentType, etag) }
}

export function serverCard(origin: string, boardPath = '') {
  return {
    $schema: MCP_SERVER_CARD_SCHEMA,
    ...MCP_SERVER_INFO,
    description: MCP_SERVER_DESCRIPTION,
    websiteUrl: 'https://sidequest.exchange',
    repository: { url: MCP_REPOSITORY, source: 'github', subfolder: 'apps/api' },
    icons: [{ src: `${origin}/icons/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] }],
    remotes: [
      {
        type: 'streamable-http',
        url: `${origin}${boardPath}/mcp`,
        supportedProtocolVersions: [MCP_PROTOCOL_VERSION, ...MCP_LEGACY_PROTOCOL_VERSIONS],
      },
      {
        type: 'streamable-http',
        url: `${origin}${boardPath}/mcp/directory`,
        supportedProtocolVersions: [MCP_PROTOCOL_VERSION, ...MCP_LEGACY_PROTOCOL_VERSIONS],
        authentication: { type: 'none' },
      },
    ],
  }
}

export function registryManifest(origin: string) {
  const card = serverCard(origin)
  return {
    ...card,
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }],
  }
}

export function serverCardReply(
  origin: string,
  boardPath: string,
  requestHeaders: Record<string, string | undefined>,
): McpMetadataReply {
  return jsonReply(serverCard(origin, boardPath), 'application/mcp-server-card+json', requestHeaders)
}

export function catalogReply(origin: string, requestHeaders: Record<string, string | undefined>): McpMetadataReply {
  return jsonReply(
    {
      specVersion: '1.0',
      entries: [
        {
          identifier: 'urn:air:sidequest.exchange:mcp:sidequest',
          type: 'application/mcp-server-card+json',
          url: `${origin}/mcp/server-card`,
        },
      ],
    },
    'application/ai-catalog+json',
    requestHeaders,
  )
}

export function registryProofReply(proof: string): McpMetadataReply {
  return {
    status: 200,
    body: `${proof}\n`,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  }
}
