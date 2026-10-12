/**
 * Live probe for ADR-0023 (P3) on Monad testnet: a hosted agent's Privy wallet signs a user operation through
 * `eth_signUserOperation` under the routine signer policy, and Pimlico's sponsoring paymaster pays its gas. The
 * operation approves nothing (Circle testnet USDC `approve(Holding, 0)`, only when that allowance is already 0). Before
 * sending it proves the policy refuses two calls outside it: a transfer, and an approval to another spender.
 *
 * Credentials are read inside this process (the dev stage env, the shell, the cutover journal) and never printed. It
 * picks an already-delegated wallet of the routine signer unless one is named.
 *
 *   bun --no-env-file packages/sdk/scripts/live/aa-privy-probe.ts [walletId]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  type Address,
  type Hex,
  concat,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
} from 'viem'
import {
  ESTIMATE_SIGNATURE,
  PrivyServer,
  PrivyServerError,
  approveCall,
  delegatorTypedData,
  deployment,
  executeCalldata,
  jsonRpc,
  laneNonce,
  nonceKey,
  p256AuthorizationSigner,
} from '../../src/index.ts'
import { type UserOperation, toBundlerJson, userOpHash } from '../../src/aa/userop.ts'
import { type Json, field, hexField, quantity } from '../../src/aa/rpc.ts'
import type { Call } from '../../src/batch.ts'

const DEAD: Address = '0x000000000000000000000000000000000000dEaD'

interface Journal {
  readonly appId: string
  readonly routinePrivateKey: string
  readonly routine: { readonly id: string }
  readonly policy: { readonly id: string }
}

function stageEnv(): Record<string, string | undefined> {
  const path = resolve(homedir(), '.config/sidequest/dev.env')
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
}

const d = deployment('monad-testnet')
const aa = d.aa
if (aa === null) throw new Error('no accountAbstraction config')
const holding = d.stacks.main?.holding
if (holding === undefined) throw new Error('no main Holding')
// SAFETY: the cutover journal is written by sidequest-cutover.ts with exactly these fields.
const journal = JSON.parse(readFileSync(resolve('.sidequest/privy-cutover.json'), 'utf8')) as Journal
const staged = stageEnv()
const appSecret = staged.PRIVY_APP_SECRET ?? process.env.PRIVY_APP_SECRET ?? ''
const pimlicoKey = staged.PIMLICO_API_KEY ?? process.env.PIMLICO_API_KEY ?? ''
if (appSecret === '' || pimlicoKey === '') throw new Error('PRIVY_APP_SECRET and PIMLICO_API_KEY are required')
if ((process.env.PRIVY_APP_ID ?? journal.appId) !== journal.appId)
  throw new Error('shell Privy app differs from journal')

const sign = await p256AuthorizationSigner(journal.routinePrivateKey)
const privy = new PrivyServer({ appId: journal.appId, appSecret, sign })
const pimlico = jsonRpc(
  `https://api.pimlico.io/v2/${d.chainId}/rpc?apikey=${encodeURIComponent(pimlicoKey)}`,
  'Pimlico',
)
const node = createPublicClient({ transport: http('https://testnet-rpc.monad.xyz') })
const delegated = concat(['0xef0100', d.delegation.delegator]).toLowerCase()
const run = `aa-privy-probe-${Date.now()}`

/** Whether a listed wallet carries exactly the routine signer under the routine policy. */
function underRoutine(wallet: Json): boolean {
  const signers = field(wallet, 'additional_signers')
  return (Array.isArray(signers) ? signers : []).some(
    (s) =>
      field(s, 'signer_id') === journal.routine.id &&
      JSON.stringify(field(s, 'override_policy_ids')) === JSON.stringify([journal.policy.id]),
  )
}

async function walletPage(cursor: string | undefined): Promise<Json> {
  const url = new URL('https://api.privy.io/v1/wallets')
  url.searchParams.set('chain_type', 'ethereum')
  url.searchParams.set('limit', '100')
  if (cursor !== undefined) url.searchParams.set('cursor', cursor)
  const response = await fetch(url, {
    headers: { 'privy-app-id': journal.appId, authorization: `Basic ${btoa(`${journal.appId}:${appSecret}`)}` },
  })
  if (!response.ok) throw new Error(`wallet list refused: HTTP ${response.status}`)
  // SAFETY: Privy's wallet list returns JSON.
  return (await response.json()) as Json
}

async function routineWallets(): Promise<{ id: string; address: Address }[]> {
  const found: { id: string; address: Address }[] = []
  let cursor: string | undefined
  do {
    const page = await walletPage(cursor)
    const data = field(page, 'data')
    for (const wallet of Array.isArray(data) ? data : [])
      if (underRoutine(wallet))
        found.push({
          id: JSON.stringify(field(wallet, 'id')).replaceAll('"', ''),
          address: hexField(field(wallet, 'address'), 'address'),
        })
    const next = field(page, 'next_cursor')
    cursor = next === null || next === undefined ? undefined : JSON.stringify(next).replaceAll('"', '')
  } while (cursor !== undefined)
  return found
}

async function pickWallet(): Promise<{ id: string; address: Address }> {
  const named = process.argv[2]
  if (named !== undefined) {
    const wallet = await privy.getWallet(named)
    return { id: wallet.id, address: wallet.address }
  }
  const wallets = await routineWallets()
  console.log(`${wallets.length} wallets under routine signer ${journal.routine.id} and policy ${journal.policy.id}`)
  for (const wallet of wallets)
    if ((await node.getCode({ address: wallet.address }))?.toLowerCase() === delegated) return wallet
  throw new Error('no routine wallet is delegated to the DeleGator yet')
}

async function gasPrice() {
  const fast = field(await pimlico('pimlico_getUserOperationGasPrice', []), 'fast')
  return {
    maxFeePerGas: quantity(field(fast, 'maxFeePerGas'), 'max fee'),
    maxPriorityFeePerGas: quantity(field(fast, 'maxPriorityFeePerGas'), 'priority fee'),
  }
}

function draft(
  sender: Address,
  lane: string,
  calls: Call[],
  fees: Awaited<ReturnType<typeof gasPrice>>,
): UserOperation {
  return {
    sender,
    nonce: laneNonce(nonceKey(lane)),
    callData: executeCalldata(calls),
    callGasLimit: 200_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 100_000n,
    ...fees,
    signature: ESTIMATE_SIGNATURE,
  }
}

/** The policy must refuse it: Privy answers 4xx and no signature comes back. */
async function refused(walletId: string, label: string, op: UserOperation): Promise<void> {
  try {
    await privy.signUserOperation(walletId, d.delegation.delegator, d.chainId, op, `${run}-${label}`)
  } catch (error) {
    if (error instanceof PrivyServerError && error.status >= 400 && error.status < 500) {
      console.log(`refused ${label}: HTTP ${error.status} (${error.code})`)
      return
    }
    throw error
  }
  throw new Error(`policy signed ${label}; it must refuse it`)
}

const wallet = await pickWallet()
console.log(`agent wallet ${wallet.id} ${wallet.address}`)
const allowance = await node.readContract({
  address: aa.gasToken,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [wallet.address, holding],
})
if (allowance !== 0n) throw new Error('the agent already approves the Holding; this probe will not reset it')
const fees = await gasPrice()
const transfer: Call = {
  to: aa.gasToken,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEAD, 0n] }),
}
await refused(wallet.id, 'transfer', draft(wallet.address, `${run}-transfer`, [transfer], fees))
await refused(
  wallet.id,
  'approve-other',
  draft(wallet.address, `${run}-other`, [approveCall(aa.gasToken, DEAD, 0n)], fees),
)

const unsigned = draft(wallet.address, run, [approveCall(aa.gasToken, holding, 0n)], fees)
const s = await pimlico('pm_sponsorUserOperation', [toBundlerJson(unsigned), aa.entryPoint])
const sponsored: UserOperation = {
  ...unsigned,
  callGasLimit: quantity(field(s, 'callGasLimit'), 'call gas'),
  verificationGasLimit: quantity(field(s, 'verificationGasLimit'), 'verification gas'),
  preVerificationGas: quantity(field(s, 'preVerificationGas'), 'pre-verification gas'),
  paymaster: hexField(field(s, 'paymaster'), 'paymaster'),
  paymasterData: hexField(field(s, 'paymasterData'), 'paymaster data'),
  paymasterVerificationGasLimit: quantity(field(s, 'paymasterVerificationGasLimit'), 'paymaster gas'),
  paymasterPostOpGasLimit: quantity(field(s, 'paymasterPostOpGasLimit'), 'paymaster post-op gas'),
}
const signature: Hex = await privy.signUserOperation(wallet.id, d.delegation.delegator, d.chainId, sponsored, run)
const recovered = await recoverTypedDataAddress({
  ...delegatorTypedData(sponsored, d.chainId, aa.entryPoint),
  signature,
})
if (!isAddressEqual(recovered, wallet.address)) throw new Error(`Privy's signature recovers to ${recovered}`)
console.log('Privy signed the DeleGator digest; it recovers to the agent')
const op = { ...sponsored, signature }
const hash = hexField(await pimlico('eth_sendUserOperation', [toBundlerJson(op), aa.entryPoint]), 'hash')
console.log(`sent ${hash}; ours ${userOpHash(op, d.chainId, aa.entryPoint)}`)
for (let attempt = 0; attempt < 40; attempt++) {
  const receipt = await pimlico('eth_getUserOperationReceipt', [hash])
  if (receipt !== null) {
    const tx = hexField(field(field(receipt, 'receipt'), 'transactionHash'), 'tx')
    console.log(`landed ${tx}: success ${String(field(receipt, 'success') === true)}`)
    process.exit(field(receipt, 'success') === true ? 0 : 1)
  }
  await new Promise((done) => setTimeout(done, 1500))
}
console.log('no receipt within 60 s')
process.exit(2)
