import { mkdir, open, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Schema } from 'effect'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

interface KeygenOptions {
  readonly generateKey?: () => Hex
  readonly print?: (message: string) => void
}

export type KeyRole = 'moderator' | 'maintainer'

/** Only Kris invokes the CLI. Unit tests supply a disposable key and temporary home. */
export async function generateRoleKey(
  role: KeyRole,
  home = homedir(),
  stage = process.env.SIDEQUEST_STAGE ?? 'dev',
  options: KeygenOptions = {},
): Promise<string> {
  const selected = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/u)))(stage)
  const name = `${role.toUpperCase()}_PRIVATE_KEY`
  const file = path.join(home, '.config', 'sidequest', `${selected}.env`)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const lockPath = `${file}.${role}-keygen.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    const handle = await open(file, 'a+', 0o600)
    try {
      await handle.chmod(0o600)
      const existing = await handle.readFile('utf8')
      const assigned = (line: string) =>
        line
          .replace(/^\s*(?:export\s+)?/u, '')
          .split('=')[0]
          ?.trim() === name
      if (existing.split('\n').some((line) => line.includes('=') && assigned(line)))
        throw new Error(`${name} is already set`)
      const key = (options.generateKey ?? generatePrivateKey)()
      const address = privateKeyToAccount(key).address
      const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
      await handle.appendFile(`${separator}${name}=${key}\n`)
      await handle.sync()
      ;(options.print ?? console.log)(`${role} address: ${address}`)
      return address
    } finally {
      await handle.close()
    }
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

export const generateModeratorKey = (home?: string, stage?: string, options?: KeygenOptions) =>
  generateRoleKey('moderator', home, stage, options)

/** `[--role moderator|maintainer] [--stage <stage>]`: the role defaults to moderator, the stage to SIDEQUEST_STAGE or dev. */
export function parseKeygenArguments(args: readonly string[]): { role: KeyRole; stage: string } {
  let role: KeyRole = 'moderator'
  let stage = process.env.SIDEQUEST_STAGE ?? 'dev'
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]]
    if (flag === '--role' && (value === 'moderator' || value === 'maintainer')) role = value
    else if (flag === '--stage' && value !== undefined) stage = value
    else throw new Error('usage: keygen [--role moderator|maintainer] [--stage <stage>]')
  }
  return { role, stage }
}

if (import.meta.main) {
  const { role, stage } = parseKeygenArguments(process.argv.slice(2))
  await generateRoleKey(role, homedir(), stage)
}
