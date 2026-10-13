/** Isolated Sidequest routine authority. Policy updates touch only the verified routine policy. */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
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
import { resolve } from 'node:path'
import { generateAuthorizationKey, p256AuthorizationSigner } from '../../src/p256.ts'
import { PrivyApi } from './client.ts'
import { adminEnv, localEnv, required } from './env.ts'
import { authorityPolicy, config } from './policy.ts'
import type { Network } from '../../src/deployment.ts'
import { explicitNetwork } from './network.ts'
import { setup, verifyAuthority, updateAuthority } from './setup.ts'
import { sidequestPolicyPlan } from './cutover-policy.ts'
import { canonical, writablePolicy } from './policy-document.ts'

type Json = Record<string, unknown>
type Plan = ReturnType<typeof sidequestPolicyPlan>
export class SidequestCutoverError extends Error {}
interface Creation {
  key: string
  startedAt: string
  id?: string
}
export interface CutoverState {
  version: 2
  appId: string
  adminId: string
  adminPublicKey: string
  legacyPolicyId: string
  legacyPolicySha256: string
  legacySignerId: string
  legacySignerPublicKey: string
  originalAppSecretSha256: string
  desiredPolicySha256: string
  routinePrivateKey: string
  routinePublicKey: string
  routine?: Creation
  policy?: Creation
  verifiedAt?: string
  policyUpdate?: { beforeSha256: string; targetSha256: string }
}
interface Api {
  checked(
    method: string,
    route: string,
    body?: Json,
    sign?: (payload: string) => Promise<string>,
    idempotencyKey?: string,
  ): Promise<Json>
}
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
export function publicKey(privateKey: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey.replace(/^wallet-auth:/, ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
}
export function assertQuorum(value: Json, id: string, key: string): void {
  const keys = value.authorization_keys as { public_key: string }[] | undefined
  if (
    value.id !== id ||
    value.authorization_threshold !== 1 ||
    keys?.length !== 1 ||
    keys[0]?.public_key !== key ||
    !Array.isArray(value.user_ids) ||
    value.user_ids.length ||
    !Array.isArray(value.key_quorum_ids) ||
    value.key_quorum_ids.length
  ) {
    throw new SidequestCutoverError('Quorum readback differs from the frozen one-key authority')
  }
}
export function assertFreshPolicy(live: Json, id: string, plan: Plan): void {
  if (id === plan.legacyPolicyId || live.id !== id || canonical(writablePolicy(live)) !== canonical(plan.create)) {
    throw new SidequestCutoverError('Separate policy readback differs from the exact reviewed policy')
  }
}
function assertState(state: CutoverState, plan: Plan, appId: string, adminId: string, adminPublicKey: string): void {
  if (
    state.version !== 2 ||
    state.appId !== appId ||
    state.adminId !== adminId ||
    state.adminPublicKey !== adminPublicKey ||
    state.legacyPolicyId !== plan.legacyPolicyId ||
    !/^[a-f0-9]{64}$/.test(state.originalAppSecretSha256) ||
    !/^[a-f0-9]{64}$/.test(state.legacyPolicySha256) ||
    !/^[a-f0-9]{64}$/.test(state.desiredPolicySha256) ||
    state.legacyPolicySha256 !== plan.legacyPolicySha256 ||
    state.desiredPolicySha256 !== fingerprint(canonical(plan.create)) ||
    state.routinePublicKey !== publicKey(state.routinePrivateKey) ||
    state.routinePublicKey === state.legacySignerPublicKey
  ) {
    throw new SidequestCutoverError('Cutover inputs changed; reconcile the frozen journal')
  }
}

/** A lost creation response is a hold, never a second POST. IDs can only resume through exact GET verification. */
export async function createSeparateAuthority(input: {
  api: Api
  state: CutoverState
  plan: Plan
  appId: string
  adminId: string
  adminPublicKey: string
  appSecret: string
  persist: (state: CutoverState) => void
  now?: () => string
  operationId?: () => string
}) {
  const { api, state, plan, appId, adminId, adminPublicKey, persist } = input
  assertState(state, plan, appId, adminId, adminPublicKey)
  if (fingerprint(input.appSecret) === state.originalAppSecretSha256)
    throw new SidequestCutoverError('Replacement app secret required before provider creation')
  const now = input.now ?? (() => new Date().toISOString())
  const operationId = input.operationId ?? (() => crypto.randomUUID())
  if (!state.routine?.id) {
    if (state.routine)
      throw new SidequestCutoverError('Unresolved routine creation; provider reconciliation required, no replay')
    state.routine = { key: operationId(), startedAt: now() }
    persist(state)
    const result = await api.checked('POST', '/key_quorums', {
      display_name: 'Sidequest dev routine Monad testnet',
      public_keys: [state.routinePublicKey],
      authorization_threshold: 1,
    })
    if (typeof result.id !== 'string' || !result.id || result.id === state.legacySignerId || result.id === adminId) {
      throw new SidequestCutoverError('Invalid fresh routine ID; reconcile the original creation')
    }
    state.routine.id = result.id
    persist(state)
  }
  assertQuorum(await api.checked('GET', `/key_quorums/${state.routine.id}`), state.routine.id, state.routinePublicKey)
  if (!state.policy?.id) {
    if (state.policy)
      throw new SidequestCutoverError('Unresolved policy creation; provider reconciliation required, no replay')
    state.policy = { key: operationId(), startedAt: now() }
    persist(state)
    const result = await api.checked('POST', '/policies', plan.create, undefined, state.policy.key)
    if (typeof result.id !== 'string' || !result.id || result.id === plan.legacyPolicyId) {
      throw new SidequestCutoverError('Invalid separate policy ID; reconcile the original creation')
    }
    state.policy.id = result.id
    persist(state)
  }
  assertFreshPolicy(await api.checked('GET', `/policies/${state.policy.id}`), state.policy.id, plan)
  // Do not bind even a verified fresh policy if shared recovery authority changed during creation.
  const legacy = await api.checked('GET', `/policies/${state.legacyPolicyId}`)
  if (fingerprint(canonical(writablePolicy(legacy))) !== state.legacyPolicySha256)
    throw new SidequestCutoverError('Legacy policy changed during cutover; refusing dev binding')
  assertQuorum(
    await api.checked('GET', `/key_quorums/${state.legacySignerId}`),
    state.legacySignerId,
    state.legacySignerPublicKey,
  )
  state.verifiedAt = now()
  persist(state)
  return { signerId: state.routine.id, policyId: state.policy.id, verifiedAt: state.verifiedAt }
}

export function devAuthorityEnv(state: CutoverState): string {
  if (
    !state.verifiedAt ||
    !state.routine?.id ||
    !state.policy?.id ||
    state.routine.id === state.legacySignerId ||
    state.policy.id === state.legacyPolicyId
  ) {
    throw new SidequestCutoverError('Only verified isolated authority may be exported for dev')
  }
  const values = {
    PRIVY_APP_ID: state.appId,
    PRIVY_SIGNER_ID: state.routine.id,
    PRIVY_POLICY_ID: state.policy.id,
    PRIVY_SIGNER_KEY: state.routinePrivateKey,
  }
  if (Object.values(values).some((value) => !value || /[\r\n'\\]/.test(value)))
    throw new SidequestCutoverError('Unsafe dev authority entry')
  return (
    Object.entries(values)
      .map(([name, value]) => `${name}='${value}'`)
      .join('\n') + '\n'
  )
}

const root = resolve(new URL('../../../..', import.meta.url).pathname, '.sidequest')
const statePath = resolve(root, 'privy-cutover.json')
const envPath = resolve(root, 'privy-dev.env')
function save(path: string, value: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
function saveCutoverState(state: CutoverState): void {
  save(statePath, JSON.stringify(state, null, 2) + '\n')
}
function safeSummary(state: CutoverState) {
  return {
    appId: state.appId,
    adminId: state.adminId,
    legacyPolicyId: state.legacyPolicyId,
    legacyPolicySha256: state.legacyPolicySha256,
    legacySignerId: state.legacySignerId,
    desiredPolicySha256: state.desiredPolicySha256,
    rules: 11,
    signerId: state.routine?.id ?? null,
    policyId: state.policy?.id ?? null,
    verifiedAt: state.verifiedAt ?? null,
    devEnvWritten: existsSync(envPath),
    legacyAuthorityPreserved: true,
  }
}
/** Update only the existing routine policy; persist its desired hash before PATCH and reconcile via GET on retry. */
export async function updateRoutinePolicy(input: {
  api: Api
  state: CutoverState
  adminId: string
  adminPublicKey: string
  network: Network
  sign: (payload: string) => Promise<string>
  persist: (state: CutoverState) => void
}) {
  const { api, state, adminId, adminPublicKey, sign, persist } = input
  if (
    state.version !== 2 ||
    !state.verifiedAt ||
    !state.policy?.id ||
    !state.routine?.id ||
    state.adminId !== adminId ||
    state.adminPublicKey !== adminPublicKey
  ) {
    throw new SidequestCutoverError('Verified routine authority and matching admin required')
  }
  await assertQuorum(await api.checked('GET', `/key_quorums/${adminId}`), adminId, adminPublicKey)
  await assertQuorum(
    await api.checked('GET', `/key_quorums/${state.routine.id}`),
    state.routine.id,
    state.routinePublicKey,
  )
  const desired = authorityPolicy(adminId, input.network)
  const live = await api.checked('GET', `/policies/${state.policy.id}`)
  if (live.id !== state.policy.id) throw new SidequestCutoverError('Routine policy readback ID differs')
  const oldHash = fingerprint(canonical(writablePolicy(live)))
  const newHash = fingerprint(canonical(desired))
  if (oldHash !== state.desiredPolicySha256 && oldHash !== newHash && oldHash !== state.policyUpdate?.beforeSha256)
    throw new SidequestCutoverError('Routine policy drift; reconcile before update')
  state.policyUpdate = { beforeSha256: oldHash, targetSha256: newHash }
  persist(state)
  if (oldHash !== newHash) await api.checked('PATCH', `/policies/${state.policy.id}`, { rules: desired.rules }, sign)
  const updated = await api.checked('GET', `/policies/${state.policy.id}`)
  if (canonical(writablePolicy(updated)) !== canonical(desired))
    throw new SidequestCutoverError('Routine policy update readback differs')
  state.desiredPolicySha256 = newHash
  delete state.policyUpdate
  state.verifiedAt = new Date().toISOString()
  persist(state)
  return { name: desired.name, appId: state.appId, adminId, signerId: state.routine.id, policyId: state.policy.id }
}

async function runPolicyUpdate(network: Network) {
  const env = process.env as Record<string, string>
  const appId = required(env, 'PRIVY_APP_ID'),
    adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const adminKey = required(env, 'PRIVY_POLICY_ADMIN_KEY')
  const lock = resolve(root, 'privy-cutover.lock'),
    descriptor = openSync(lock, 'wx', 0o600)
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as CutoverState
    if (
      state.appId !== appId ||
      state.policy?.id !== required(env, 'PRIVY_POLICY_ID') ||
      state.routine?.id !== required(env, 'PRIVY_SIGNER_ID')
    )
      throw new SidequestCutoverError('Stage authority differs from cutover journal')
    return await updateRoutinePolicy({
      api: new PrivyApi(appId, required(env, 'PRIVY_APP_SECRET')),
      state,
      adminId,
      network,
      adminPublicKey: publicKey(adminKey),
      sign: await p256AuthorizationSigner(adminKey),
      persist: saveCutoverState,
    })
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

export async function runCutover(mode: 'prepare' | 'apply' | 'verify' | 'update-policy', network: Network) {
  if (network === 'monad-mainnet') {
    if (mode === 'verify') return verifyAuthority(network)
    if (mode === 'update-policy') return updateAuthority(network)
    if (mode !== 'apply' || process.env.SIDEQUEST_PRIVY_APPLY !== '1')
      throw new SidequestCutoverError(
        'Use setup.ts monad-mainnet to prepare new authority; apply requires SIDEQUEST_PRIVY_APPLY=1',
      )
    return setup(network)
  }
  if (mode === 'update-policy') return runPolicyUpdate(network)
  if (mode === 'verify' && process.env.PRIVY_POLICY_ID !== undefined && process.env.PRIVY_APP_SECRET !== undefined) {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as CutoverState
    const env = process.env as Record<string, string>
    if (
      state.appId !== required(env, 'PRIVY_APP_ID') ||
      state.policy?.id !== required(env, 'PRIVY_POLICY_ID') ||
      state.routine?.id !== required(env, 'PRIVY_SIGNER_ID') ||
      fingerprint(canonical(authorityPolicy(state.adminId, network))) !== state.desiredPolicySha256
    )
      throw new SidequestCutoverError('Stage routine authority differs from journal')
    const api = new PrivyApi(state.appId, required(env, 'PRIVY_APP_SECRET'))
    const live = await api.checked('GET', `/policies/${state.policy.id}`)
    if (canonical(writablePolicy(live)) !== canonical(authorityPolicy(state.adminId, network)))
      throw new SidequestCutoverError('Routine policy readback differs')
    assertQuorum(await api.checked('GET', `/key_quorums/${state.routine.id}`), state.routine.id, state.routinePublicKey)
    return {
      name: 'Sidequest routine authority',
      appId: state.appId,
      policyId: state.policy.id,
      signerId: state.routine.id,
    }
  }
  if (
    config.chainId !== 10143 ||
    config.deployment?.main?.kind !== 'sidequest-v1' ||
    config.sidequest?.reuseCore === true
  ) {
    throw new SidequestCutoverError('Fresh Sidequest testnet deployment required')
  }
  const env = localEnv()
  const appId = required(env, 'PRIVY_APP_ID')
  if (appId !== 'cmui9skoc01zr0dl03tyahirs') throw new SidequestCutoverError('Unexpected Sidequest dev app')
  const appSecret = required(env, 'PRIVY_APP_SECRET')
  const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const legacyPolicyId = required(env, 'PRIVY_POLICY_ID')
  const legacySignerId = required(env, 'PRIVY_SIGNER_ID')
  const legacySignerPublicKey = publicKey(required(env, 'PRIVY_SIGNER_KEY'))
  const adminPublicKey = publicKey(required(adminEnv(), 'PRIVY_POLICY_ADMIN_KEY'))
  const api = new PrivyApi(appId, appSecret)
  const archived = JSON.parse(
    readFileSync(
      new URL('../../../../contracts/config/archive/pre-sidequest-monad-testnet.json', import.meta.url),
      'utf8',
    ),
  )
  const plan = sidequestPolicyPlan(
    await api.checked('GET', `/policies/${legacyPolicyId}`),
    authorityPolicy(adminId, network),
    {
      holding: archived.deployment.main.holding,
      core: archived.deployment.core,
      relay: archived.roles.relay,
    },
  )
  if (plan.legacyPolicyId !== legacyPolicyId) throw new SidequestCutoverError('Unexpected legacy policy readback ID')
  assertQuorum(await api.checked('GET', `/key_quorums/${adminId}`), adminId, adminPublicKey)
  assertQuorum(await api.checked('GET', `/key_quorums/${legacySignerId}`), legacySignerId, legacySignerPublicKey)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = resolve(root, 'privy-cutover.lock')
  const descriptor = openSync(lock, 'wx', 0o600)
  try {
    let state: CutoverState
    if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8')) as CutoverState
    else {
      if (mode !== 'prepare')
        throw new SidequestCutoverError('Prepare the frozen journal before replacing credentials or applying')
      const key = await generateAuthorizationKey()
      state = {
        version: 2,
        appId,
        adminId,
        adminPublicKey,
        legacyPolicyId,
        legacyPolicySha256: plan.legacyPolicySha256,
        legacySignerId,
        legacySignerPublicKey,
        originalAppSecretSha256: fingerprint(appSecret),
        desiredPolicySha256: fingerprint(canonical(plan.create)),
        routinePrivateKey: key.privateKey,
        routinePublicKey: key.publicKey,
      }
      saveCutoverState(state)
    }
    assertState(state, plan, appId, adminId, adminPublicKey)
    if (state.legacySignerId !== legacySignerId || state.legacySignerPublicKey !== legacySignerPublicKey)
      throw new SidequestCutoverError('Legacy signer changed; reconcile recovery authority')
    if (mode === 'apply') {
      if (process.env.SIDEQUEST_PRIVY_APPLY !== '1')
        throw new SidequestCutoverError('Explicit Sidequest authority apply required')
      await createSeparateAuthority({
        api,
        state,
        plan,
        appId,
        adminId,
        adminPublicKey,
        appSecret,
        persist: saveCutoverState,
      })
      assertQuorum(await api.checked('GET', `/key_quorums/${adminId}`), adminId, adminPublicKey)
      // Atomically write an ignored dev-only overlay; never replace .env.local's legacy signer/policy entries.
      if (existsSync(envPath) && readFileSync(envPath, 'utf8') !== devAuthorityEnv(state))
        throw new SidequestCutoverError('Existing dev overlay differs; reconcile before binding')
      if (!existsSync(envPath)) save(envPath, devAuthorityEnv(state))
    } else if (mode === 'verify') {
      if (!state.routine?.id || !state.policy?.id)
        throw new SidequestCutoverError('Fresh authority creation is incomplete')
      assertQuorum(
        await api.checked('GET', `/key_quorums/${state.routine.id}`),
        state.routine.id,
        state.routinePublicKey,
      )
      assertFreshPolicy(await api.checked('GET', `/policies/${state.policy.id}`), state.policy.id, plan)
      if (!existsSync(envPath) || readFileSync(envPath, 'utf8') !== devAuthorityEnv(state))
        throw new SidequestCutoverError('Dev overlay is missing or changed')
    }
    return { mode, ...safeSummary(state) }
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}
if (import.meta.main) {
  try {
    const network = explicitNetwork(process.argv[2])
    const mode = process.argv[3]
    if (process.argv.length !== 4 || !['prepare', 'apply', 'verify', 'update-policy'].includes(mode ?? ''))
      throw new SidequestCutoverError('Use <network> prepare|apply|verify|update-policy')
    console.log(
      JSON.stringify(await runCutover(mode as 'prepare' | 'apply' | 'verify' | 'update-policy', network), null, 2),
    )
  } catch (error) {
    console.error(
      error instanceof SidequestCutoverError
        ? error.message
        : 'Sidequest authority refused; credentials and provider response suppressed',
    )
    process.exitCode = 1
  }
}
