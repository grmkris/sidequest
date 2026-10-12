import { describe, expect, it } from 'vitest'
import { type AccountAbstraction, aaFromConfig, deployment } from '@sidequest/sdk'
import mainnetConfig from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { type Hex, decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbstractionFailures } from '../src/aa-preflight.ts'

const testnet = deployment('monad-testnet').aa!
const signerKey: Hex = `0x${'5'.repeat(64)}`
const signer = privateKeyToAccount(signerKey).address
const ABI = parseAbi([
  'function signer() view returns (address)',
  'function getDepositInfo(address account) view returns ((uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime))',
])

interface Chain {
  readonly chainId?: string
  readonly entryPoints?: readonly string[]
  readonly quotedPaymaster?: string
  readonly paymasterSigner?: Hex
  readonly deposit?: bigint
  readonly staked?: boolean
  readonly unstakeDelaySec?: number
}

function services(chain: Chain = {}) {
  const answers: Record<string, unknown> = {
    eth_chainId: chain.chainId ?? '0x279f',
    eth_supportedEntryPoints: chain.entryPoints ?? [testnet.entryPoint],
    pimlico_getTokenQuotes: {
      quotes: [{ paymaster: chain.quotedPaymaster ?? '0x7777777777777777777777777777777777777777' }],
    },
  }
  const fetcher: typeof fetch = async (_url, init) => {
    // SAFETY: the preflight sends one JSON-RPC request object per call.
    const body = JSON.parse(await new Request('https://pimlico.test', init).text()) as { method: string }
    return Response.json({ jsonrpc: '2.0', id: 1, result: answers[body.method] })
  }
  const reader = {
    call: async (_to: string, data: `0x${string}`) => {
      const { functionName } = decodeFunctionData({ abi: ABI, data })
      return functionName === 'signer'
        ? encodeFunctionResult({ abi: ABI, functionName, result: chain.paymasterSigner ?? signer })
        : encodeFunctionResult({
            abi: ABI,
            functionName,
            result: {
              deposit: chain.deposit ?? 10n ** 18n,
              staked: chain.staked ?? true,
              stake: 10n ** 18n,
              unstakeDelaySec: chain.unstakeDelaySec ?? 86_400,
              withdrawTime: 0,
            },
          })
    },
  }
  return { fetcher, reader }
}

const env = { PIMLICO_API_KEY: 'pim_test', TESTNET_PAYMASTER_SIGNER_KEY: signerKey }
const check = (
  chain: Chain = {},
  overrides: Record<string, string | undefined> = {},
  aa: AccountAbstraction = testnet,
) =>
  accountAbstractionFailures({
    aa,
    chainId: aa === testnet ? 10143 : 143,
    env: { ...env, ...overrides },
    ...services(chain),
  })

describe('the release preflight for gas in USDC (ADR-0023)', () => {
  it('passes a testnet stage whose Pimlico key, paymaster signer, stake and deposit are live', async () => {
    expect(await check()).toEqual([])
  })

  it.each([
    [{}, { PIMLICO_API_KEY: '' }, 'PIMLICO_API_KEY missing'],
    [{ chainId: '0x8f' }, {}, 'Pimlico chain mismatch'],
    [{ entryPoints: [] }, {}, 'Pimlico does not serve the EntryPoint'],
    [{}, { TESTNET_PAYMASTER_SIGNER_KEY: 'nope' }, 'TESTNET_PAYMASTER_SIGNER_KEY missing or invalid'],
    [
      { paymasterSigner: privateKeyToAccount(`0x${'6'.repeat(64)}`).address },
      {},
      "testnet paymaster signer is not the Worker's key",
    ],
    [{ staked: false }, {}, 'testnet paymaster is not staked'],
    [{ unstakeDelaySec: 60 }, {}, 'testnet paymaster is not staked'],
    [{ deposit: 0n }, {}, 'testnet paymaster has no EntryPoint deposit'],
  ] as const)('refuses %o %o: %s', async (chain, overrides, failure) => {
    expect(await check(chain, overrides)).toContain(failure)
  })

  it('never puts the key in a failure', async () => {
    const failures = await check({ chainId: '0x8f' }, { TESTNET_PAYMASTER_SIGNER_KEY: 'nope' })
    expect(failures.join(' ')).not.toContain('pim_test')
  })

  it('passes mainnet only when Pimlico quotes the gas token through the configured paymaster', async () => {
    const mainnet = aaFromConfig(mainnetConfig)!
    const quoted = { chainId: '0x8f', quotedPaymaster: mainnet.paymaster! }
    expect(await check(quoted, {}, mainnet)).toEqual([])
    expect(await check({ ...quoted, quotedPaymaster: signer }, {}, mainnet)).toEqual([
      'Pimlico does not quote the gas token through the configured paymaster',
    ])
  })
})
