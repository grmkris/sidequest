import { createPrivateKey, createPublicKey } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { PrivyApi, PrivyApiError } from './client.ts'
import { networkAdminEnv, networkAdminEnvPath, appendEnv, networkEnvPath, networkEnv, required } from './env.ts'
import type { Network } from '../../src/deployment.ts'
import { explicitNetwork } from './network.ts'
import { generateAuthorizationKey, p256AuthorizationSigner } from '../../src/p256.ts'
import { authorityPolicy } from './policy.ts'
import { canonical, writablePolicy } from './policy-document.ts'

function stateDirectoryFor(network: Network): URL {
  return new URL(network === 'monad-mainnet' ? './.local/monad-mainnet/' : './.local/', import.meta.url)
}

interface Creation {
  key: string
  startedAt: string
  id?: string
  rejected?: boolean
}

function saveState(state: Record<string, Creation>, network: Network): void {
  const stateDirectory = stateDirectoryFor(network)
  const statePath = new URL('setup.json', stateDirectory)
  const temporary = new URL('setup.json.tmp', stateDirectory)
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, statePath)
}

function publicAuthorizationKey(privateKey: string): string {
  const object = createPrivateKey({
    key: Buffer.from(privateKey.replace(/^wallet-auth:/, ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  return createPublicKey(object).export({ format: 'der', type: 'spki' }).toString('base64')
}

async function verifyQuorum(api: PrivyApi, id: string, publicKey: string, name: string): Promise<void> {
  const quorum = await api.checked('GET', `/key_quorums/${id}`)
  const keys = quorum.authorization_keys as { public_key: string }[]
  if (
    quorum.authorization_threshold !== 1 ||
    keys?.length !== 1 ||
    keys[0]?.public_key !== publicKey ||
    (quorum.user_ids as unknown[])?.length ||
    (quorum.key_quorum_ids as unknown[])?.length
  ) {
    throw new Error(`Unexpected ${name} quorum; refusing authority drift`)
  }
}

/** Add only missing exact rules. A changed or additional live rule is drift, never an automatic widening. */
export function authorityRulesUpdate(
  live: Record<string, unknown>,
  desired: ReturnType<typeof authorityPolicy>,
): boolean {
  const before = writablePolicy(live)
  if (canonical(before) === canonical(desired)) return false
  const { rules: liveRules, ...liveHeader } = before
  const { rules: desiredRules, ...desiredHeader } = desired
  if (canonical(liveHeader) !== canonical(desiredHeader) || !Array.isArray(liveRules))
    throw new Error('Policy authority drift; refusing update')
  const available = new Set(desiredRules.map((rule) => canonical({ rules: [rule] })))
  if (liveRules.some((rule) => !available.has(canonical({ rules: [rule] }))))
    throw new Error('Policy rule drift; refusing update')
  return true
}

export async function updateAuthority(network: Network): Promise<{ policyId: string; status: string }> {
  const env = networkEnv(network)
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const policyId = required(env, 'PRIVY_POLICY_ID')
  const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const desired = authorityPolicy(adminId, network)
  const stateDirectory = stateDirectoryFor(network)
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const lock = new URL('setup.lock', stateDirectory)
  const descriptor = openSync(lock, 'wx', 0o600)
  try {
    const live = await api.checked('GET', `/policies/${policyId}`)
    if (live.id !== policyId) throw new Error('Policy ID differs; refusing update')
    const adding = authorityRulesUpdate(live, desired)
    if (adding) {
      writeFileSync(
        new URL('update.json', stateDirectory),
        `${JSON.stringify({ network, policyId, desired: canonical(desired) })}\n`,
        { mode: 0o600 },
      )
      const sign = await p256AuthorizationSigner(required(networkAdminEnv(network), 'PRIVY_POLICY_ADMIN_KEY'))
      await api.checked('PATCH', `/policies/${policyId}`, { rules: desired.rules }, sign)
    }
    await verifyAuthority(network)
    return { policyId, status: adding ? 'added' : 'current' }
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

async function verifyPolicy(api: PrivyApi, id: string, adminId: string, network: Network): Promise<void> {
  const desired = authorityPolicy(adminId, network)
  const policy = await api.checked('GET', `/policies/${id}`)
  if (policy.id !== id || canonical(writablePolicy(policy)) !== canonical(desired)) {
    throw new Error('Policy drift; no automatic widening')
  }
}

/** Verification performs only GETs and never creates a key, quorum, policy or local setup state. */
export async function verifyAuthority(
  network: Network,
): Promise<{ signerId: string; adminId: string; policyId: string }> {
  authorityPolicy('preflight', network)
  const env = networkEnv(network)
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const signerId = required(env, 'PRIVY_SIGNER_ID')
  const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const policyId = required(env, 'PRIVY_POLICY_ID')
  await verifyQuorum(api, signerId, publicAuthorizationKey(required(env, 'PRIVY_SIGNER_KEY')), 'routine')
  await verifyQuorum(
    api,
    adminId,
    publicAuthorizationKey(required(networkAdminEnv(network), 'PRIVY_POLICY_ADMIN_KEY')),
    'policy-admin',
  )
  await verifyPolicy(api, policyId, adminId, network)
  return { signerId, adminId, policyId }
}

export async function setup(network: Network): Promise<{ signerId: string; adminId: string; policyId: string }> {
  authorityPolicy('preflight', network)
  const stateDirectory = stateDirectoryFor(network)
  const statePath = new URL('setup.json', stateDirectory)
  const envPath = networkEnvPath(network)
  const adminEnvPath = networkAdminEnvPath(network)
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const lock = new URL('setup.lock', stateDirectory)
  const descriptor = openSync(lock, 'wx', 0o600)
  try {
    const env = networkEnv(network)
    const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
    const state: Record<string, Creation> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}

    async function keyQuorum(
      name: string,
      keyName: string,
      path: string,
      secrets: Record<string, string>,
    ): Promise<string> {
      let privateKey = secrets[keyName]
      if (!privateKey) {
        privateKey = (await generateAuthorizationKey()).privateKey
        appendEnv(path, keyName, privateKey)
      }
      const publicKey = publicAuthorizationKey(privateKey)
      const idName = name === 'routine' ? 'PRIVY_SIGNER_ID' : 'PRIVY_POLICY_ADMIN_ID'
      let id = env[idName] ?? state[name]?.id
      if (!id) {
        // Quorum creation has no documented idempotency contract. Refuse an ambiguous replay.
        if (state[name]) throw new Error(`Unresolved ${name} quorum creation; reconcile in Privy before retrying`)
        state[name] = { key: crypto.randomUUID(), startedAt: new Date().toISOString() }
        saveState(state, network)
        const result = await api.checked('POST', '/key_quorums', {
          display_name: `Sidequest v2 ${name} ${network}`,
          public_keys: [publicKey],
          authorization_threshold: 1,
        })
        id = required(result as Record<string, string>, 'id')
        state[name]!.id = id
        saveState(state, network)
      }
      await verifyQuorum(api, id, publicKey, name)
      appendEnv(envPath, idName, id)
      return id
    }

    const signerId = await keyQuorum('routine', 'PRIVY_SIGNER_KEY', envPath, env)
    const adminId = await keyQuorum('policy-admin', 'PRIVY_POLICY_ADMIN_KEY', adminEnvPath, networkAdminEnv(network))
    const desired = authorityPolicy(adminId, network)
    let policyId = env.PRIVY_POLICY_ID ?? state.policy?.id
    if (!policyId) {
      if (state.policy && !state.policy.rejected)
        throw new Error('Unresolved policy creation; reconcile the original request before retrying')
      state.policy = { key: crypto.randomUUID(), startedAt: new Date().toISOString() }
      saveState(state, network)
      let result: Record<string, unknown>
      try {
        result = await api.checked('POST', '/policies', desired, undefined, state.policy.key)
      } catch (error) {
        // A confirmed validation rejection created nothing; network failures remain ambiguous.
        if (error instanceof PrivyApiError && error.status === 400) {
          state.policy.rejected = true
          saveState(state, network)
        }
        throw error
      }
      policyId = required(result as Record<string, string>, 'id')
      state.policy.id = policyId
      saveState(state, network)
    }
    await verifyPolicy(api, policyId, adminId, network)
    appendEnv(envPath, 'PRIVY_POLICY_ID', policyId)
    return { signerId, adminId, policyId }
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

if (import.meta.main) {
  try {
    const [networkArg, ...flags] = process.argv.slice(2)
    const network = explicitNetwork(networkArg)
    if (flags.length > 1 || flags.some((argument) => argument !== '--verify'))
      throw new Error('Use setup.ts <network> [--verify]')
    console.log(JSON.stringify(await (flags.includes('--verify') ? verifyAuthority(network) : setup(network))))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Privy setup failed; response suppressed')
    process.exitCode = 1
  }
}
