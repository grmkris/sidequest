import { chmodSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import type { Network } from '../../src/deployment.ts'

export const envPath = resolve('.env.local')
export const adminEnvPath = resolve(homedir(), '.config/secrets.env')

export function networkEnvPath(network: Network): string {
  return network === 'monad-mainnet' ? resolve(homedir(), '.config/sidequest/prod.env') : envPath
}

export function networkEnv(network: Network): Record<string, string> {
  return definedEnv(readFileSync(networkEnvPath(network), 'utf8'))
}

export function networkAdminEnvPath(network: Network): string {
  return network === 'monad-mainnet' ? networkEnvPath(network) : adminEnvPath
}

export function networkAdminEnv(network: Network): Record<string, string> {
  return definedEnv(readFileSync(networkAdminEnvPath(network), 'utf8'))
}

function definedEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseEnv(source)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** Read files explicitly: shell credentials may belong to a different Privy app. */
export function localEnv(): Record<string, string> {
  return parseEnv(readFileSync(envPath, 'utf8')) as Record<string, string>
}

export function adminEnv(): Record<string, string> {
  return parseEnv(readFileSync(adminEnvPath, 'utf8')) as Record<string, string>
}

export function required(env: Record<string, string>, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}; no credential values are printed`)
  return value
}

/** Append only; never replace somebody else's key or rewrite the surrounding secrets. */
export function appendEnv(path: string, name: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n'\\]/.test(value)) {
    throw new Error('Unsafe environment entry')
  }
  const source = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const current = parseEnv(source)[name]
  if (current !== undefined) {
    if (current !== value) throw new Error(`Refusing to replace ${name}`)
    return
  }
  if (existsSync(path)) chmodSync(path, 0o600)
  appendFileSync(path, `\n${name}='${value}'\n`, { mode: 0o600 })
}
