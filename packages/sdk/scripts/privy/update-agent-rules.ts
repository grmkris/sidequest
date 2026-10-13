/**
 * Adds the V1.1 hosted-agent rules to the live testnet routine-signer policy, and nothing else: x402
 * TransferWithAuthorization and the directory records (Enrollment, ServiceAd, RevokeAd). Dry-run by default; `--yes`
 * signs the PATCH with the policy-admin key, only with Kris's explicit go-ahead (one quorum session for all four).
 */
import { p256AuthorizationSigner } from '../../src/p256.ts'
import { PrivyApi, PrivyApiError } from './client.ts'
import { networkAdminEnv, networkEnv, required } from './env.ts'
import type { Network } from '../../src/deployment.ts'
import { explicitNetwork } from './network.ts'
import { deployment } from '../../src/deployment.ts'
import { DIRECTORY_RECORD_KINDS, X402_PAYMENT_CAP, authorityPolicy } from './policy.ts'
import { verifyAuthority } from './setup.ts'
import { canonical, writablePolicy } from './policy-document.ts'

type JsonRecord = Record<string, unknown>
type Rule = ReturnType<typeof authorityPolicy>['rules'][number]

/** The only rules this update may add. */
export const AGENT_RULES = [
  'Allow TransferWithAuthorization',
  ...DIRECTORY_RECORD_KINDS.map((kind) => `Allow ${kind}`),
] as const

export class AgentRulesUpdateError extends Error {}

/**
 * `current` when the live policy equals the desired one; `add` when it equals the desired policy without some of the
 * new rules (a partial earlier apply included). Any other difference, including a new rule with other conditions, is
 * drift and refused.
 */
export function agentRulesUpdate(
  live: JsonRecord,
  desired: ReturnType<typeof authorityPolicy>,
): { status: 'current' } | { status: 'add'; adding: string[]; rules: Rule[] } {
  const before = writablePolicy(live)
  for (const name of AGENT_RULES)
    if (desired.rules.filter((rule) => rule.name === name).length !== 1)
      throw new AgentRulesUpdateError(`The desired policy must hold exactly one ${name} rule`)
  if (canonical(before) === canonical(desired)) return { status: 'current' }
  const present = new Set((before.rules as JsonRecord[]).map((rule) => rule.name))
  const adding = AGENT_RULES.filter((name) => !present.has(name))
  const expected = {
    ...desired,
    rules: desired.rules.filter((rule) => !adding.includes(rule.name as (typeof AGENT_RULES)[number])),
  }
  if (adding.length === 0 || canonical(before) !== canonical(expected))
    throw new AgentRulesUpdateError('Policy drift beyond the hosted-agent rules; refusing update')
  return { status: 'add', adding, rules: desired.rules }
}

export async function updateAgentRules(network: Network, apply = false) {
  const selected = deployment(network)
  const env = networkEnv(network)
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const policyId = required(env, 'PRIVY_POLICY_ID')
  const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const desired = authorityPolicy(adminId, network)
  const live = await api.checked('GET', `/policies/${policyId}`)
  if (live.id !== policyId) throw new AgentRulesUpdateError('Unexpected policy ID; refusing update')
  const update = agentRulesUpdate(live, desired)
  const summary = {
    policyId,
    usdc: selected.x402?.usdc,
    x402CapBaseUnits: X402_PAYMENT_CAP,
    identityRegistry: selected.identity,
    status: update.status,
    ...(update.status === 'add' ? { adding: update.adding } : {}),
  }
  if (!apply || update.status === 'current') return { mode: apply ? 'apply' : 'dry-run', ...summary }

  const sign = await p256AuthorizationSigner(required(networkAdminEnv(network), 'PRIVY_POLICY_ADMIN_KEY'))
  await api.checked('PATCH', `/policies/${policyId}`, { rules: update.rules }, sign)
  const verified = await verifyAuthority(network)
  if (verified.policyId !== policyId || verified.adminId !== adminId)
    throw new AgentRulesUpdateError('Authority IDs changed during verification; reconcile the original policy')
  return { mode: 'apply', ...summary, status: 'added' }
}

if (import.meta.main) {
  try {
    const [networkArg, ...args] = process.argv.slice(2)
    const network = explicitNetwork(networkArg)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--yes'))
      throw new AgentRulesUpdateError('Use update-agent-rules.ts <network> [--yes]')
    console.log(JSON.stringify(await updateAgentRules(network, args[0] === '--yes')))
  } catch (error) {
    console.error(
      error instanceof AgentRulesUpdateError || error instanceof PrivyApiError
        ? error.message
        : 'Privy agent-rules update failed; response and credentials suppressed',
    )
    process.exitCode = 1
  }
}
