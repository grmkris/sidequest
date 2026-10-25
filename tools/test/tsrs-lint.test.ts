import { Schema } from 'effect'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { assetUrl, cachedBinary, fetchVerified, target, TSRS_LINT } from '../tsrs-lint.ts'

const owned: string[] = []
const servers: http.Server[] = []
afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) server.close()
})

const scratch = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sidequest-tsrs-lint-'))
  owned.push(dir)
  return dir
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The listening address of a `node:http` server bound to a TCP port. */
const Address = Schema.Struct({ port: Schema.Number })

/** A release server: `/good` answers the binary, `/missing` answers 404. */
const serve = async (binary: Buffer): Promise<string> => {
  const server = http.createServer((request, response) => {
    if (request.url === '/good') response.end(binary)
    else response.writeHead(404, 'Not Found').end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = Schema.decodeUnknownSync(Address)(server.address())
  return `http://127.0.0.1:${port}`
}

const binary = Buffer.from('#!/bin/sh\necho tsrs-lint\n')

test('the pin names a tag and a 64-hex sha256 per release asset', () => {
  expect(TSRS_LINT.tag).toMatch(/^lint-pr\d+-[0-9a-f]{7}-regions\.\d+$/u)
  for (const sum of Object.values(TSRS_LINT.sha256)) expect(sum).toMatch(/^[0-9a-f]{64}$/u)
  expect(assetUrl('x86_64-unknown-linux-gnu')).toBe(
    `https://github.com/grmkris/tsrs/releases/download/${TSRS_LINT.tag}/tsrs-lint-x86_64-unknown-linux-gnu`,
  )
})

test('the target is the Rust triple of the platform; others have no build', () => {
  expect(target('linux', 'x64')).toBe('x86_64-unknown-linux-gnu')
  expect(target('darwin', 'arm64')).toBe('aarch64-apple-darwin')
  expect(() => target('linux', 'arm64')).toThrow(/no release build for linux-arm64/u)
  expect(() => target('win32', 'x64')).toThrow(/no release build for win32-x64/u)
})

test('the cache is $XDG_CACHE_HOME or ~/.cache, per tag, and .vscode/settings.json points the oxc extension there', () => {
  expect(cachedBinary({ XDG_CACHE_HOME: '/var/cache' })).toBe(`/var/cache/tsrs-lint/${TSRS_LINT.tag}/tsrs-lint`)
  expect(cachedBinary({})).toBe(path.join(os.homedir(), '.cache', 'tsrs-lint', TSRS_LINT.tag, 'tsrs-lint'))
  const settings = readFileSync(path.join(import.meta.dirname, '../../.vscode/settings.json'), 'utf8')
  const parsed: unknown = JSON.parse(
    settings
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n'),
  )
  expect(parsed).toMatchObject({ 'oxc.path.tsgolint': `\${userHome}/.cache/tsrs-lint/${TSRS_LINT.tag}/tsrs-lint` })
})

test('a download that matches the pin is installed executable and returned', async () => {
  const base = await serve(binary)
  const file = path.join(scratch(), 'tag', 'tsrs-lint')
  await expect(fetchVerified({ url: `${base}/good`, sha256: sha256(binary), file })).resolves.toBe(file)
  expect(readFileSync(file)).toEqual(binary)
  expect(statSync(file).mode & 0o111).toBe(0o111)
})

test('a download whose checksum differs from the pin fails and installs nothing', async () => {
  const base = await serve(binary)
  const file = path.join(scratch(), 'tsrs-lint')
  const wrong = sha256(Buffer.from('other'))
  await expect(fetchVerified({ url: `${base}/good`, sha256: wrong, file })).rejects.toThrow(
    new RegExp(`${base}/good has sha256 ${sha256(binary)}, the pin says ${wrong}; nothing was installed`, 'u'),
  )
  expect(existsSync(file)).toBe(false)
})

test('a missing release asset fails with its status', async () => {
  const base = await serve(binary)
  const file = path.join(scratch(), 'tsrs-lint')
  await expect(fetchVerified({ url: `${base}/missing`, sha256: sha256(binary), file })).rejects.toThrow(
    /answered 404 Not Found/u,
  )
  expect(existsSync(file)).toBe(false)
})

test('a cached binary is verified on every use and never downloaded again', async () => {
  const file = path.join(scratch(), 'tsrs-lint')
  writeFileSync(file, binary)
  chmodSync(file, 0o755)
  const unreachable = 'http://127.0.0.1:1/never'
  await expect(fetchVerified({ url: unreachable, sha256: sha256(binary), file })).resolves.toBe(file)
  const wrong = sha256(Buffer.from('other'))
  await expect(fetchVerified({ url: unreachable, sha256: wrong, file })).rejects.toThrow(
    new RegExp(`${file} has sha256 ${sha256(binary)}, the pin says ${wrong}; delete it to download again`, 'u'),
  )
  expect(existsSync(file)).toBe(true)
})
