import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateModeratorKey, generateRoleKey, parseKeygenArguments } from './keygen.ts'

// Synthetic unit-test key, never a funded or operational key.
const key: Hex = `0x${'1'.repeat(64)}`
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true })
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'moderator-keygen-test-'))
  homes.push(home)
  return home
}

describe('moderator keygen in a temporary HOME', () => {
  it('appends once, preserves existing values, prints only the address and sets mode 600', async () => {
    const home = await temporaryHome()
    const file = path.join(home, '.config/sidequest/dev.env')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'EXISTING=test', { mode: 0o644 })
    const generateKey = vi.fn(() => key)
    const print = vi.fn()
    const address = await generateModeratorKey(home, 'dev', { generateKey, print })
    expect(address).toBe(privateKeyToAccount(key).address)
    expect(await readFile(file, 'utf8')).toBe(`EXISTING=test\nMODERATOR_PRIVATE_KEY=${key}\n`)
    expect(print.mock.calls).toEqual([[`moderator address: ${address}`]])
    expect(JSON.stringify(print.mock.calls)).not.toContain(key)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(generateModeratorKey(home, 'dev', { generateKey, print })).rejects.toThrow('already set')
    expect(generateKey).toHaveBeenCalledOnce()
    expect(print).toHaveBeenCalledOnce()
  })

  it('refuses even an empty existing key and creates a missing stage file privately', async () => {
    const home = await temporaryHome()
    await generateModeratorKey(home, 'local', { generateKey: () => key, print: vi.fn() })
    const file = path.join(home, '.config/sidequest/local.env')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, 'MODERATOR_PRIVATE_KEY=\n')
    await expect(generateModeratorKey(home, 'local', { generateKey: () => key })).rejects.toThrow('already set')
  })

  it('rejects a stage path outside the config directory', async () => {
    await expect(generateModeratorKey(await temporaryHome(), '../other', { generateKey: () => key })).rejects.toThrow()
  })
})

describe('maintainer keygen', () => {
  it('appends its own variable beside the moderator key, once, and prints only its address', async () => {
    const home = await temporaryHome()
    await generateModeratorKey(home, 'dev', { generateKey: () => key, print: vi.fn() })
    const other: Hex = `0x${'2'.repeat(64)}`
    const print = vi.fn()
    const address = await generateRoleKey('maintainer', home, 'dev', { generateKey: () => other, print })
    const file = path.join(home, '.config/sidequest/dev.env')
    expect(await readFile(file, 'utf8')).toBe(`MODERATOR_PRIVATE_KEY=${key}\nMAINTAINER_PRIVATE_KEY=${other}\n`)
    expect(print.mock.calls).toEqual([[`maintainer address: ${address}`]])
    await expect(generateRoleKey('maintainer', home, 'dev', { generateKey: () => other })).rejects.toThrow(
      'MAINTAINER_PRIVATE_KEY is already set',
    )
  })

  it('reads --role and --stage, defaulting to the moderator', () => {
    expect(parseKeygenArguments(['--role', 'maintainer']).role).toBe('maintainer')
    expect(parseKeygenArguments(['--stage', 'local'])).toMatchObject({ role: 'moderator', stage: 'local' })
    expect(() => parseKeygenArguments(['--role', 'arbiter'])).toThrow('usage')
  })
})
