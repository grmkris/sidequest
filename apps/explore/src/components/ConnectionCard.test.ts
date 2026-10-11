import { describe, expect, it } from 'vitest'
import { CLIENT_SETUP } from '../client-setup.ts'

describe('MCP connection instructions', () => {
  const endpoint = 'https://dev.sidequest.exchange/mcp'

  it('gives each supported client one endpoint-specific line and the step that follows', () => {
    expect(CLIENT_SETUP.claude(endpoint).line).toBe(
      `claude mcp add --transport http --scope user sidequest ${endpoint}`,
    )
    expect(CLIENT_SETUP.claude(endpoint).after).toContain('/mcp → sidequest → Authenticate')
    expect(CLIENT_SETUP.codex(endpoint).line).toBe(`codex mcp add sidequest --url ${endpoint}`)
    expect(CLIENT_SETUP.codex(endpoint).fallback).toBe('codex mcp login sidequest --no-browser')
    expect(CLIENT_SETUP.grok(endpoint).line).toBe(`grok mcp add --transport http sidequest ${endpoint}`)
    expect(CLIENT_SETUP.grok(endpoint).after).toContain('/mcps → sidequest → i')
    expect(JSON.parse(CLIENT_SETUP.cursor(endpoint).line)).toEqual({ mcpServers: { sidequest: { url: endpoint } } })
  })

  it('gives Cursor a one-click install link carrying the same server config', () => {
    const link = new URL(CLIENT_SETUP.cursor(endpoint).install!)
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('cursor://anysphere.cursor-deeplink/mcp/install')
    expect(link.searchParams.get('name')).toBe('sidequest')
    expect(JSON.parse(atob(link.searchParams.get('config')!))).toEqual({ url: endpoint })
    expect(CLIENT_SETUP.claude(endpoint).install).toBeUndefined()
  })
})
