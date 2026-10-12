/**
 * Release preflight for gas in USDC (ADR-0023). Before a prod deploy it proves the pieces user operations need are
 * live, in read-only calls:
 * - Pimlico serves this chain and our EntryPoint with the stage's key.
 * - On mainnet, Pimlico quotes the gas token through the configured ERC-20 paymaster.
 * - On testnet, our paymaster's quote signer is the Worker's key, and the paymaster is staked and has a deposit.
 * Returns failure labels only, never a key, URL or provider body.
 */
import { type AccountAbstraction, type Json, field, hexField, pimlicoUrl } from '@sidequest/sdk'
import { type Address, decodeFunctionResult, encodeFunctionData, isAddressEqual, isHex, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { LaunchReader } from './prod-config.ts'

const PAYMASTER_ABI = parseAbi(['function signer() view returns (address)'])
const ENTRY_POINT_ABI = parseAbi([
  'function getDepositInfo(address account) view returns ((uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime))',
])
/** Bundlers want a paymaster that keeps a context staked with at least a day's unstake delay (ERC-7562). */
const MIN_UNSTAKE_DELAY = 86_400

export interface AaPreflightInput {
  readonly aa: AccountAbstraction | null
  readonly chainId: number
  readonly env: NodeJS.ProcessEnv
  readonly fetcher: typeof fetch
  readonly reader: Pick<LaunchReader, 'call'>
}

async function pimlico(
  input: AaPreflightInput,
  key: string,
  method: string,
  params: Json[],
): Promise<Json | undefined> {
  const response = await input.fetcher(pimlicoUrl(input.chainId, key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('Pimlico refused')
  // SAFETY: `Response.json` returns what JSON.parse built, which is a JSON value by construction.
  return field((await response.json()) as Json, 'result')
}

/** Pimlico answers for this chain and lists our EntryPoint; on mainnet it quotes the gas token via our paymaster. */
async function pimlicoFailures(input: AaPreflightInput, aa: AccountAbstraction): Promise<string[]> {
  const key = input.env.PIMLICO_API_KEY ?? ''
  if (key === '' || key === 'unset') return ['PIMLICO_API_KEY missing']
  try {
    if (Number(await pimlico(input, key, 'eth_chainId', [])) !== input.chainId) return ['Pimlico chain mismatch']
    const entryPoints = await pimlico(input, key, 'eth_supportedEntryPoints', [])
    const listed = (Array.isArray(entryPoints) ? entryPoints : []).some(
      (address) => isHex(address) && isAddressEqual(address, aa.entryPoint),
    )
    if (!listed) return ['Pimlico does not serve the EntryPoint']
    if (aa.paymasterKind !== 'pimlico-erc20') return []
    const quotes = field(
      await pimlico(input, key, 'pimlico_getTokenQuotes', [
        { tokens: [aa.gasToken] },
        aa.entryPoint,
        `0x${input.chainId.toString(16)}`,
      ]),
      'quotes',
    )
    const quoted = Array.isArray(quotes) ? hexField(field(quotes[0], 'paymaster'), 'paymaster') : '0x'
    return aa.paymaster !== null && quoted.length === 42 && isAddressEqual(quoted, aa.paymaster)
      ? []
      : ['Pimlico does not quote the gas token through the configured paymaster']
  } catch {
    return ['Pimlico unavailable']
  }
}

async function read(reader: AaPreflightInput['reader'], to: Address, data: `0x${string}`): Promise<`0x${string}`> {
  return reader.call(to, data)
}

/** The address of a hex private key, or null for a missing or invalid one (never echoing it). */
function keyAddress(raw: string | undefined): Address | null {
  if (raw === undefined || !isHex(raw, { strict: true }) || raw.length !== 66) return null
  try {
    return privateKeyToAccount(raw).address
  } catch {
    return null
  }
}

/** Our testnet paymaster: its quote signer is the Worker's key, and it is staked with a deposit to pay bundlers. */
async function testnetPaymasterFailures(input: AaPreflightInput, aa: AccountAbstraction): Promise<string[]> {
  const paymaster = aa.paymaster
  if (paymaster === null) return ['testnet paymaster not recorded in config']
  const signerKey = keyAddress(input.env.TESTNET_PAYMASTER_SIGNER_KEY)
  if (signerKey === null) return ['TESTNET_PAYMASTER_SIGNER_KEY missing or invalid']
  try {
    const signer = decodeFunctionResult({
      abi: PAYMASTER_ABI,
      functionName: 'signer',
      data: await read(input.reader, paymaster, encodeFunctionData({ abi: PAYMASTER_ABI, functionName: 'signer' })),
    })
    if (!isAddressEqual(signer, signerKey)) return ["testnet paymaster signer is not the Worker's key"]
    const info = decodeFunctionResult({
      abi: ENTRY_POINT_ABI,
      functionName: 'getDepositInfo',
      data: await read(
        input.reader,
        aa.entryPoint,
        encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: 'getDepositInfo', args: [paymaster] }),
      ),
    })
    const failures: string[] = []
    if (!info.staked || info.unstakeDelaySec < MIN_UNSTAKE_DELAY) failures.push('testnet paymaster is not staked')
    if (info.deposit === 0n) failures.push('testnet paymaster has no EntryPoint deposit')
    return failures
  } catch {
    return ['testnet paymaster read failed']
  }
}

/** Every reason the stage cannot send user operations; empty when it can. */
export async function accountAbstractionFailures(input: AaPreflightInput): Promise<string[]> {
  const aa = input.aa
  if (aa === null) return ['accountAbstraction config missing']
  const failures = await pimlicoFailures(input, aa)
  if (aa.paymasterKind === 'sidequest-testnet') failures.push(...(await testnetPaymasterFailures(input, aa)))
  return failures
}

/** Throws `<label>: <failures>` when the stage cannot send user operations. */
export async function assertAccountAbstraction(label: string, input: AaPreflightInput): Promise<void> {
  const failures = await accountAbstractionFailures(input)
  if (failures.length > 0) throw new Error(`${label} account abstraction check failed: ${failures.join(', ')}`)
}
