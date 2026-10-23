#!/usr/bin/env node
/**
 * ADR-0029 cutover: imports the media kit into a stage's media library through the media tools, as a media operator
 * signed in over SIWE, then checks every public file through /media/f. Rerunnable: every call carries a deterministic
 * operationKey. The kit stays as it is.
 *
 *   node scripts/media/import-kit.mjs --manifest kit.json --origin https://dev.sidequest.exchange --key <key file>
 *     [--today YYYY-MM-DD] [--dry-run]
 *
 * The manifest is the kit's full manifest ({ groups, assets, posts }); the key file holds a media operator's private
 * key and never leaves the machine.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { privateKeyToAccount } from 'viem/accounts'
import { planImport, rewriteBrief } from './import-kit-model.mjs'

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    origin: { type: 'string' },
    key: { type: 'string' },
    today: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
})
if (values.manifest === undefined || values.origin === undefined || (values.key === undefined && !values['dry-run']))
  throw new Error('usage: import-kit.mjs --manifest kit.json --origin <stage origin> --key <key file> [--dry-run]')
const origin = new URL(values.origin).origin
const today = values.today ?? new Date().toISOString().slice(0, 10)
const manifest = JSON.parse(readFileSync(values.manifest, 'utf8'))
const plan = planImport(manifest, today)
const count = (tool) => plan.calls.filter((call) => call.tool === tool).length
console.log(
  `plan: ${count('save_media_group')} sections, ${count('add_media')} assets, ${count('publish_media')} published, ` +
    `${count('record_media_post')} posts, ${count('save_media_post')} planned; skipped ${plan.skipped.join(', ') || 'none'}; archived ${plan.archived.join(', ')}`,
)
if (values['dry-run']) process.exit(0)

async function api(tool, args, session) {
  const response = await fetch(`${origin}/api/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { authorization: `Bearer ${session}` }),
    },
    body: JSON.stringify(args),
  })
  return response.json()
}

const account = privateKeyToAccount(readFileSync(values.key, 'utf8').trim())
const { result: challenge } = await api('auth_challenge', { address: account.address })
const login = await api('auth_login', {
  message: challenge.message,
  signature: await account.signMessage({ message: challenge.message }),
})
const session = login.result?.session
if (session === undefined) throw new Error(`sign-in failed: ${login.message ?? 'no session'}`)

/** The since-launch brief, its film-material links pointed at the share, uploaded as bytes. */
async function rewrittenBrief(call, shareUrl) {
  const text = rewriteBrief(await (await fetch(call.args.files[0].sourceUrl)).text(), shareUrl)
  const bytes = new TextEncoder().encode(text)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const prepared = await api(
    'prepare_media_upload',
    { operationKey: `${call.key}:upload`, files: [{ sha256, bytes: bytes.length, type: 'text/markdown' }] },
    session,
  )
  const upload = prepared.result?.files?.[0]
  if (upload?.stored === false) {
    const put = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'text/markdown' }, body: bytes })
    if (!put.ok) throw new Error(`brief upload ${put.status}`)
  }
  const { sourceUrl: _sourceUrl, ...file } = call.args.files[0]
  return { ...call.args, files: [{ ...file, sha256 }] }
}

let shareUrl
let failed = 0
for (const call of plan.calls) {
  const args =
    call.brief === 'since-launch.md' && shareUrl !== undefined ? await rewrittenBrief(call, shareUrl) : call.args
  const reply = await api(call.tool, { operationKey: call.key, ...args }, session)
  if (call.tool === 'share_media' && reply.ok) shareUrl = reply.result.url
  if (!reply.ok) failed++
  console.log(
    `${reply.ok ? 'ok  ' : 'FAIL'} ${call.tool} ${call.key}${reply.ok ? '' : ` — ${reply.code}: ${reply.message}`}`,
  )
}

// Every public file, through the same URL /media links to, with its length.
const listed = await api('list_media', { level: 'public' }, session)
let checked = 0
for (const asset of listed.result?.assets ?? [])
  for (const file of asset.files) {
    // Uncompressed, so the reply keeps its length (the zone compresses text types and drops Content-Length).
    const head = await fetch(file.url, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } })
    checked++
    if (head.status !== 200 || head.headers.get('content-length') !== String(file.bytes)) {
      failed++
      console.log(`FAIL serve ${asset.id}/${file.name} — ${head.status} ${head.headers.get('content-length')}`)
    }
  }
console.log(
  `checked ${checked} public files; ${failed} failures${shareUrl === undefined ? '' : '; film-material share made'}`,
)
process.exitCode = failed === 0 ? 0 : 1
