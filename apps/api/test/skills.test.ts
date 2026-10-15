import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, test } from 'vitest'
import { ROLE_GUIDES, connectorInstructions } from '../src/mcp-instructions.ts'
import { SKILL_MANIFESTS } from '../src/generated/skills.ts'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { PUBLIC_DIRECTORY_TOOLS, requiredToolScope } from '../src/mcp-policy.ts'
import { tools } from '../src/tools.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { directoryTools } from '../src/directory.ts'
import { agentTools } from '../src/tools-agents.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8')
/** Named by a hosted skill but reached another way: build_activation is prepare_activation's internal continuation. */
const NOT_DIRECT_MCP = new Set(['build_activation'])

describe('skills are the single source for hosted MCP guidance', () => {
  it('keeps the generated module current with skill/', () => {
    expect(() =>
      execFileSync('node', ['scripts/gen-skills.mjs', '--check'], { cwd: root, stdio: 'pipe' }),
    ).not.toThrow()
  })

  it('sends connector instructions under the 2,048 characters MCP clients keep', () => {
    for (const origin of ['https://dev.sidequest.exchange', 'https://sidequest.exchange']) {
      const text = connectorInstructions(origin)
      expect(text.length).toBeLessThanOrEqual(2048)
      expect(text).toContain(`${origin}/start.md`)
      expect(text).not.toContain('{{')
    }
  })

  it('serves each role SKILL.md body without front matter', () => {
    for (const role of ['connector', 'worker', 'publisher'] as const) {
      const body = read(`skill/${role}/SKILL.md`)
        .replace(/^---\n[\s\S]*?\n---\n+/, '')
        .trimEnd()
      expect(ROLE_GUIDES[role]).toBe(body)
      expect(ROLE_GUIDES[role].startsWith('# Sidequest ')).toBe(true)
    }
  })

  it('serves the self-custody recipe tools through /mcp/directory', () => {
    const recipe = read('skill/self-run/SKILL.md').split('## List yourself with your own wallet')[1]!
    const named = [...recipe.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(5)
    const unknown = named.filter((name) => name !== 'eth_signTypedData_v4' && !PUBLIC_DIRECTORY_TOOLS.has(name))
    expect(unknown).toEqual([])
  })

  it('names only tools that hosted MCP exposes', () => {
    const registry = new Set([
      'get_instructions',
      'search_docs',
      ...Object.keys(tools),
      ...Object.keys(tenantTools),
      ...Object.keys(directoryTools),
      ...Object.keys(agentTools),
    ])
    const files = [
      'skill/start.md',
      'skill/connector/SKILL.md',
      'skill/worker/SKILL.md',
      'skill/publisher/SKILL.md',
      'skill/connector/INSTRUCTIONS.md',
    ]
    const named = new Set(
      files.flatMap((file) => [...read(file).matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]!)),
    )
    const unknown = [...named].filter((name) => !registry.has(name))
    const hidden = [...named].filter(
      (name) => registry.has(name) && !NOT_DIRECT_MCP.has(name) && requiredToolScope(name) === undefined,
    )
    expect({ unknown, hidden }).toEqual({ unknown: [], hidden: [] })
  })
})

test('SEP-2640 manifests preserve raw bytes, frontmatter and digest', () => {
  expect(SKILL_MANIFESTS).toHaveLength(3)
  for (const skill of SKILL_MANIFESTS) {
    expect(skill.uri).toMatch(/^skill:\/\/sidequest\/[a-z0-9-]+\/SKILL\.md$/)
    expect(skill.raw).toContain(`name: ${skill.frontmatter.name}`)
    expect(parse(/^---\n([\s\S]*?)\n---\n/.exec(skill.raw)![1]!)).toEqual(skill.frontmatter)
    expect(skill.resources).toEqual([
      {
        uri: skill.uri,
        digest: `sha256:${createHash('sha256').update(skill.raw, 'utf8').digest('hex')}`,
        size: Buffer.byteLength(skill.raw),
      },
    ])
  }
})

test('MCP skill bytes and manifest digests render the request origin', async () => {
  const { renderedSkillManifests } = await import('../src/generated/skills.ts')
  for (const skill of await renderedSkillManifests('https://sidequest.exchange')) {
    expect(skill.raw).not.toContain('{{SIDEQUEST_ORIGIN}}')
    expect(skill.raw).not.toContain('dev.sidequest.exchange')
    expect(skill.resources[0]?.digest).toBe(`sha256:${createHash('sha256').update(skill.raw, 'utf8').digest('hex')}`)
    expect(skill.resources[0]?.size).toBe(Buffer.byteLength(skill.raw))
  }
})
