import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLIENT_SETUP, type Client } from './src/client-setup.ts'

/** Each surface used to keep its own copy of the connect commands, and they drifted (Jonas's Codex, 11 Oct). */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const codeBlocks = (markdown: string) =>
  [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1].trim())
// The docs formatter spaces JSON out, so Cursor's entry is compared as data.
const sameJson = (block: string, line: string) => {
  try {
    return JSON.stringify(JSON.parse(block)) === JSON.stringify(JSON.parse(line))
  } catch {
    return false
  }
}
const guides = ['skill/start.md', 'apps/docs/content/docs/quickstart.mdx']
const clients: readonly Client[] = ['claude', 'codex', 'grok', 'cursor']

describe('one connect recipe for every client', () => {
  it.each(clients)('start.md and the quickstart give the website’s %s lines word for word', (client) => {
    const setup = CLIENT_SETUP[client]('{{SIDEQUEST_ORIGIN}}/mcp')
    const lines = [setup.line, ...(setup.fallback === undefined ? [] : [setup.fallback])]
    for (const guide of guides) {
      const blocks = codeBlocks(read(guide))
      for (const line of lines)
        expect(
          blocks.some((block) => block.split('\n').includes(line) || sameJson(block, line)),
          `${guide} lacks ${line}`,
        ).toBe(true)
    }
  })

  it('the connector skill points at start.md instead of keeping its own commands', () => {
    const connector = read('skill/connector/SKILL.md')
    expect(connector).not.toMatch(/^(claude|codex|grok) mcp /m)
    expect(connector).toContain('{{SIDEQUEST_ORIGIN}}/start.md')
  })

  it('never asks a client to pick roles or a registration mode', () => {
    for (const guide of [...guides, 'skill/connector/SKILL.md'])
      expect(read(guide)).not.toMatch(
        /--oauth-resource|--oauth-client-registration|mcp login sidequest --scopes sidequest:setup/,
      )
  })
})
