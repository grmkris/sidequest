import { boardKey, viewerKey } from './queries.ts'
import { currentBoardId } from './api.ts'
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { type Abi, type Address, type Hex, getAddress, hexToBigInt, isHex, size, slice, toFunctionSelector } from 'viem'
import { ApiError, type TxRequest, tool } from './api.ts'
import { sidequest } from './sidequest.ts'
import { deployment } from './wallet.ts'

/** A delegation's root authority (it derives from no other delegation). */
const ROOT_AUTHORITY = `0x${'f'.repeat(64)}`

/** What the relay may do, read from the delegation's caveats (never from a separate claim by the board). */
export interface SponsorPolicy {
  targets: Array<{ address: Address; name: string }>
  methods: Array<{ selector: Hex; name: string }>
  calls: bigint
  /** Unix seconds; the delegation stops working at it. */
  validUntil: number
}

export interface SponsorStatus {
  status: 'none' | 'live' | 'expired' | 'used' | 'revoked'
  /** The signed delegation's `eth_signTypedData_v4` JSON, or null when there is none. */
  typedData: string | null
  delegationHash: Hex | null
  callsUsed: number
}

export interface SponsorPrep {
  /** `eth_signTypedData_v4` JSON of the ERC-7710 delegation from this wallet's DeleGator to the relay. */
  sign: { typedData: string }
  /** Set when the wallet still has to point its EIP-7702 code at the DeleGator; the relay sends that for it. */
  upgrade: { delegator: string } | null
}

/** What a sponsorship delegation is held to: this chain's manager, the relay, the framework's enforcers, Sidequest's contracts. */
export interface SponsorRules {
  chainId: number
  manager: string
  relay: string
  enforcers: sdk.DelegationEnforcers
  targets: Record<string, { name: string; abi: Abi }>
}

function sponsorRules(): SponsorRules {
  return sponsorRulesFor(sidequest, deployment)
}

/** The rules for a given deployment: the same mapping the board's SponsorDesk builds its delegation from. */
export function sponsorRulesFor(
  contracts: { holding: string; evaluator: string; vault: string },
  d: Pick<sdk.Deployment, 'chainId' | 'core' | 'relay' | 'delegation'>,
): SponsorRules {
  const targets: SponsorRules['targets'] = {
    [contracts.holding.toLowerCase()]: { name: 'Holding', abi: sdk.sidequestHoldingAbi as Abi },
    [contracts.evaluator.toLowerCase()]: { name: 'Evaluator', abi: sdk.sidequestEvaluatorAbi as Abi },
    [contracts.vault.toLowerCase()]: { name: 'Stake vault', abi: sdk.stakeVaultAbi as Abi },
    [d.core.toLowerCase()]: { name: 'Core', abi: sdk.coreAbi as Abi },
    [d.delegation.manager.toLowerCase()]: { name: 'Delegation manager', abi: sdk.delegationManagerAbi as Abi },
  }
  return {
    chainId: d.chainId,
    manager: d.delegation.manager,
    relay: d.relay,
    enforcers: d.delegation.enforcers,
    targets,
  }
}

type Json = Record<string, unknown>
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const refused = (problem: string) => ({ ok: false as const, problem })

/**
 * Reads a sponsorship delegation, and refuses it unless it is a root delegation from this wallet to Sidequest's relay,
 * under this chain's DelegationManager, built only from the framework's enforcers, and limited in all four ways B6
 * names: only Sidequest's contracts, only listed functions, a number of calls, an end time. Without the targets limit
 * the relay could act as the wallet anywhere (a token transfer, say), so that is refused whatever the board says.
 */
export function readDelegation(
  typedData: string,
  wallet: string,
  rules: SponsorRules,
): { ok: true; policy: SponsorPolicy } | { ok: false; problem: string } {
  let parsed: { primaryType?: unknown; domain?: Json; message?: Json }
  try {
    parsed = JSON.parse(typedData) as typeof parsed
  } catch {
    return refused('The permission could not be read.')
  }
  const { domain = {}, message = {} } = parsed
  if (parsed.primaryType !== 'Delegation') return refused('This is not a delegation.')
  if (Number(domain.chainId) !== rules.chainId || !same(domain.verifyingContract, rules.manager))
    return refused('The permission is for another network or contract.')
  if (!same(message.delegator, wallet)) return refused('The permission is not from your wallet.')
  if (!same(message.delegate, rules.relay)) return refused('The permission is not to Sidequest’s relay.')
  if (!same(message.authority, ROOT_AUTHORITY)) return refused('The permission derives from another one.')
  const caveats = Array.isArray(message.caveats) ? (message.caveats as Json[]) : []
  if (caveats.length === 0) return refused('The permission has no limits.')
  const known = Object.values(rules.enforcers) as string[]
  if (!caveats.every((c) => known.some((e) => same(c?.enforcer, e)) && typeof c?.terms === 'string' && isHex(c.terms)))
    return refused('The permission uses a limit Sidequest does not know.')
  const terms = (enforcer: string): Hex | null => {
    const found = caveats.filter((c) => same(c.enforcer, enforcer)).map((c) => c.terms as Hex)
    return found.length === 1 ? (found[0] ?? null) : null
  }
  const t = terms(rules.enforcers.allowedTargets)
  const m = terms(rules.enforcers.allowedMethods)
  const n = terms(rules.enforcers.limitedCalls)
  const w = terms(rules.enforcers.timestamp)
  if (t === null || m === null || n === null || w === null)
    return refused('The permission is missing a limit on contracts, functions, calls or time.')
  if (size(t) === 0 || size(t) % 20 !== 0 || size(m) === 0 || size(m) % 4 !== 0 || size(n) !== 32 || size(w) !== 32)
    return refused('A limit in the permission is malformed.')

  const targets = Array.from({ length: size(t) / 20 }, (_, i) => getAddress(slice(t, i * 20, (i + 1) * 20)))
  const unknown = targets.find((a) => rules.targets[a.toLowerCase()] === undefined)
  if (unknown !== undefined)
    return refused(`The permission lets the relay call ${unknown}, which is not a Sidequest contract.`)
  const names = new Map<string, string>()
  for (const a of targets) {
    for (const item of rules.targets[a.toLowerCase()]?.abi ?? [])
      if (item.type === 'function') names.set(toFunctionSelector(item), item.name)
  }
  const methods = Array.from({ length: size(m) / 4 }, (_, i) => {
    const selector = slice(m, i * 4, (i + 1) * 4)
    return { selector, name: names.get(selector) ?? selector }
  })
  const calls = hexToBigInt(n)
  // The board's timestamp terms: 16 bytes "valid after", then 16 bytes "valid before" (0 = no bound).
  const validUntil = Number(hexToBigInt(slice(w, 16, 32)))
  if (calls === 0n || validUntil === 0) return refused('The permission has no call count or no end time.')
  return {
    ok: true,
    policy: {
      targets: targets.map((address) => ({ address, name: rules.targets[address.toLowerCase()]?.name ?? address })),
      methods,
      calls,
      validUntil,
    },
  }
}

/**
 * The signed-in wallet's live sponsorship, read back from its own signed delegation: what the relay may send for it
 * and how many calls it has used. `settled` is false while the status is still loading, so a step does not open the
 * wallet for something Sidequest would have paid for.
 */
export function useLiveSponsorship(
  wallet: string | undefined,
  signedIn: boolean,
): { live: { policy: SponsorPolicy; callsUsed: number } | null; settled: boolean } {
  const rules = sponsorRules()
  const status = useSponsorStatus(wallet, signedIn)
  if (wallet === undefined || !signedIn) return { live: null, settled: true }
  if (status.isLoading) return { live: null, settled: false }
  const s = status.data
  if (s?.status !== 'live' || s.typedData === null) return { live: null, settled: true }
  const read = readDelegation(s.typedData, wallet, rules)
  return { live: read.ok ? { policy: read.policy, callsUsed: s.callsUsed } : null, settled: true }
}

export function useSponsorStatus(wallet: string | undefined, signedIn: boolean) {
  return useQuery({
    queryKey: boardKey(currentBoardId(), 'sponsor_status', viewerKey(wallet, signedIn)),
    queryFn: () => tool<SponsorStatus>('sponsor_status', { wallet }),
    enabled: wallet !== undefined && signedIn,
    staleTime: 30_000,
    retry: false,
  })
}

/**
 * A sponsored send: the relay's one transaction for 1–8 ordered calls (B6). `dropped` (B6 21:27): the relay's nonce
 * went to another transaction and this one has no receipt, so it never mines; like `reverted`, nothing happened, and
 * a new attempt needs a new key.
 */
export interface SponsorOperation {
  operationId: Hex
  status: 'pending' | 'confirmed' | 'reverted' | 'dropped'
  txHash: Hex
  callsUsed: number
}

/** The calls of one sponsored send, as `sponsor_submit` takes them: the board ignores description and gas. */
export interface SponsorCall {
  to: string
  data: string
  value: '0'
}

/** How many calls one sponsored send may carry (B6). */
export const SPONSOR_BATCH = 8

/**
 * Whether these transactions can go through the relay as one sponsored send: at most eight, all on this chain with no
 * value, each to a contract and function the signed delegation allows, and with that many calls left on it. Anything
 * else (an ERC-20 approve, a Safe transaction, the delegation's own revocation) goes from the wallet.
 */
export function sponsorable(
  txs: readonly TxRequest[],
  live: { policy: SponsorPolicy; callsUsed: number } | null,
  chainId: number,
  now = Date.now() / 1000,
): boolean {
  if (live === null || txs.length === 0 || txs.length > SPONSOR_BATCH) return false
  if (BigInt(live.callsUsed + txs.length) > live.policy.calls || live.policy.validUntil <= now + 60) return false
  const targets = new Set(live.policy.targets.map((t) => t.address.toLowerCase()))
  const methods = new Set(live.policy.methods.map((m) => m.selector.toLowerCase()))
  return txs.every(
    (t) =>
      t.chainId === chainId &&
      (t.value ?? '0') === '0' &&
      targets.has(t.to.toLowerCase()) &&
      isHex(t.data) &&
      t.data.length >= 10 &&
      methods.has(t.data.slice(0, 10).toLowerCase()),
  )
}

/**
 * What a failed `sponsor_submit` means for the steps. A refusal with a reason (or a 4xx-style code) is final and
 * nothing was sent: the steps go from the wallet instead, except a simulation failure (they would fail there too) and
 * a relay busy with an earlier send (try again). Anything else (no answer, a dropped connection, a server error) may
 * or may not have reached the relay, and is reconciled by submitting the same calls with the same key again: the
 * board keys the operation on it, so a retry returns the same send and never makes a second one.
 */
export type SubmitFailure = { kind: 'wallet'; why: string } | { kind: 'failed'; message: string } | { kind: 'lost' }

const WHY: Record<string, string> = {
  cap: 'Sidequest’s gas budget for today is used up',
  floor: 'Sidequest’s relay is low on gas money',
  rate: 'you have used the sponsored sends allowed for now',
  unavailable: 'gas sponsorship is unavailable right now',
  policy: 'Sidequest does not pay the gas for these steps',
}

export function submitFailure(e: unknown): SubmitFailure {
  if (!(e instanceof ApiError)) return { kind: 'lost' }
  if (e.reason === 'simulation')
    return {
      kind: 'failed',
      message: 'Sidequest checked these steps against the chain and they would fail, so nothing was sent.',
    }
  if (e.reason === 'pending')
    return {
      kind: 'failed',
      message: 'Sidequest’s relay is finishing an earlier transaction, so nothing was sent. Try again in a moment.',
    }
  if (e.reason !== undefined && WHY[e.reason] !== undefined) return { kind: 'wallet', why: WHY[e.reason] as string }
  if (e.code === 'rate-limited') return { kind: 'wallet', why: WHY.rate as string }
  if (e.code === 'unavailable') return { kind: 'wallet', why: WHY.unavailable as string }
  if (e.code === 'unauthenticated') return { kind: 'wallet', why: 'you are not signed in to Sidequest' }
  if (e.code === 'conflict') return { kind: 'wallet', why: 'your gas sponsorship is not active' }
  if (e.code === 'forbidden' || e.code === 'invalid' || e.code === 'not-found')
    return { kind: 'wallet', why: WHY.policy as string }
  return { kind: 'lost' }
}

/**
 * The caller key of one sponsored send (B6, 20:26): the board dedupes on (wallet, key), so a retry with the same key
 * returns the same operation and never a second send, while a new action with identical calls gets a new key and goes.
 */
export function sponsorKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `tx_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Cutover keeps permission removal; no browser creates or submits a relay grant. */
export const sponsorApi = {
  revoke: (wallet: string) => tool<{ transactions: TxRequest[] }>('sponsor_revoke', { wallet }),
}
