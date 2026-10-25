/**
 * The type-aware lint backend: `tsrs-lint`, the Rust port of oxlint-tsgolint, from a pinned release of grmkris/tsrs
 * (ADR 0032). oxlint runs it for the type-aware rules when `OXLINT_TSGOLINT_PATH` names it, which `bun run lint`
 * (tools/oxlint.ts), the collectors (tools/findings.ts) and `check:files` do through `oxlintEnv()`.
 *
 *   bun tools/tsrs-lint.ts        downloads this machine's binary from the release when the cache lacks it, verifies
 *                                 its sha256 against the pin, and prints its path
 *
 * `TSRS_LINT` is the one place the pin lives: the tag and the sha256 of each release asset (the release's SHA256SUMS).
 * A platform without a build, a download that fails and a checksum that differs all fail the run. Nothing falls back
 * to oxlint-tsgolint, which is not installed. The cache is `$XDG_CACHE_HOME/tsrs-lint/<tag>/tsrs-lint`, by default
 * `~/.cache/tsrs-lint/<tag>/tsrs-lint`, the path .vscode/settings.json gives the oxc extension
 * (tools/test/tsrs-lint.test.ts keeps the two equal).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const TSRS_LINT = {
  repository: 'grmkris/tsrs',
  tag: 'lint-pr624-0acc433-regions.1',
  sha256: {
    'x86_64-unknown-linux-gnu': '17fef910b56c1638a9429e2c6e5f22dd89591234821687dc443d116be63832a5',
    'aarch64-apple-darwin': '8e10bd8a4861f1b7b3bd4ce2e13af0341b0a54af5cc7a73587e7a4772ff510e0',
  },
} as const

export type Target = keyof typeof TSRS_LINT.sha256

/** The release asset for a machine: the Rust target of its platform and architecture. */
export const target = (platform: string = process.platform, arch: string = process.arch): Target => {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu'
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  const built = Object.keys(TSRS_LINT.sha256).join(' and ')
  throw new Error(`tsrs-lint: no release build for ${platform}-${arch}; tools/tsrs-lint.ts pins ${built}`)
}

export const assetUrl = (forTarget: Target): string =>
  `https://github.com/${TSRS_LINT.repository}/releases/download/${TSRS_LINT.tag}/tsrs-lint-${forTarget}`

/** Where the verified binary lives, one per machine; an empty `XDG_CACHE_HOME` counts as unset, as the XDG spec says. */
export const cachedBinary = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CACHE_HOME
  const cache = xdg === undefined || xdg === '' ? path.join(os.homedir(), '.cache') : xdg
  return path.join(cache, 'tsrs-lint', TSRS_LINT.tag, 'tsrs-lint')
}

export interface Asset {
  readonly url: string
  readonly sha256: string
  readonly file: string
}

const sha256 = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex')

const download = async (url: string, file: string): Promise<void> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`tsrs-lint: ${url} answered ${response.status} ${response.statusText}`)
  await mkdir(path.dirname(file), { recursive: true })
  const partial = `${file}.${process.pid}.download`
  await writeFile(partial, Buffer.from(await response.arrayBuffer()), { mode: 0o755 })
  await rename(partial, file)
}

/** `file`, downloaded from `url` when absent, with the pinned sha256; a differing checksum is an error, not a fallback. */
export const fetchVerified = async ({ url, sha256: expected, file }: Asset): Promise<string> => {
  const fresh = !existsSync(file)
  if (fresh) await download(url, file)
  const actual = await sha256(file)
  if (actual === expected) return file
  if (fresh) await rm(file)
  const advice = fresh ? 'nothing was installed' : 'delete it to download again'
  throw new Error(`tsrs-lint: ${fresh ? url : file} has sha256 ${actual}, the pin says ${expected}; ${advice}`)
}

/** The verified binary for this machine, downloaded once per tag. */
export const tsrsLint = (): Promise<string> => {
  const forTarget = target()
  return fetchVerified({ url: assetUrl(forTarget), sha256: TSRS_LINT.sha256[forTarget], file: cachedBinary() })
}

/** The environment oxlint runs with: `OXLINT_TSGOLINT_PATH` names the backend of the type-aware rules. */
export const oxlintEnv = async (): Promise<NodeJS.ProcessEnv> => ({
  ...process.env,
  OXLINT_TSGOLINT_PATH: await tsrsLint(),
})

if (import.meta.main) console.log(await tsrsLint())
