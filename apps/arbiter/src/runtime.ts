import * as sdk from '@sidequest/sdk'
import {
  type Hex,
  type LocalAccount,
  type PublicClient,
  TransactionReceiptNotFoundError,
  decodeFunctionData,
  keccak256,
  parseTransaction,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { homedir } from 'node:os'
import { rulingJournal, type RulingJournal, type RulingSend } from './ruling-journal.ts'

/** The v1 arbitrator uses its dedicated key. */
export function arbiterAccounts(deployment: sdk.Deployment, env: NodeJS.ProcessEnv): LocalAccount[] {
  const name =
    deployment.network === 'monad-mainnet' ? 'SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY' : 'V1_ARBITRATOR_PRIVATE_KEY'
  const account = accountFromPrivateKey(name, env)
  if (deployment.network === 'monad-mainnet' && account.address.toLowerCase() !== deployment.arbitrator.toLowerCase())
    throw new Error(`${name} address mismatch`)
  return [account]
}

/** Read only the selected role key, and never include its value in an error. */
export function accountFromPrivateKey(name: string, env: NodeJS.ProcessEnv): LocalAccount {
  const key = env[name]
  if (key === undefined || key === '') throw new Error(`${name} is not set`)
  if (!/^0x[\da-fA-F]{64}$/.test(key)) throw new Error(`${name} is invalid`)
  try {
    // SAFETY: The exact 32-byte hex format is checked above, and viem validates the scalar.
    return privateKeyToAccount(key as Hex)
  } catch {
    throw new Error(`${name} is invalid`)
  }
}

type CancellationReads = Pick<
  PublicClient,
  'getChainId' | 'getBalance' | 'estimateGas' | 'estimateFeesPerGas' | 'waitForTransactionReceipt'
>

/** The account that signs the ruling also pays cancellation gas. Never attempt an unfunded retry. */
export async function sendFundedCancellation(
  wallet: sdk.Wallet,
  reads: CancellationReads,
  transaction: sdk.TxRequest,
): Promise<void> {
  if (transaction.chainId !== wallet.chain.id || transaction.value !== '0')
    throw new Error('Ruling cancellation chain/value refused')
  let gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, balance: bigint
  try {
    if ((await reads.getChainId()) !== transaction.chainId) throw new Error('chain mismatch')
    const [estimate, fees, available] = await Promise.all([
      reads.estimateGas({ account: wallet.account, to: transaction.to, data: transaction.data, value: 0n }),
      reads.estimateFeesPerGas({ chain: wallet.chain, type: 'eip1559' }),
      reads.getBalance({ address: wallet.account.address, blockTag: 'pending' }),
    ])
    const estimated = (estimate * 120n + 99n) / 100n,
      requested = BigInt(transaction.gas ?? '0')
    gas = estimated > requested ? estimated : requested
    if (gas < 100_000n) gas = 100_000n
    maxFeePerGas = fees.maxFeePerGas
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas
    balance = available
  } catch {
    throw new Error('Ruling cancellation gas reserve could not be checked')
  }
  if (maxFeePerGas <= 0n || balance < gas * maxFeePerGas)
    throw new Error('Fund the arbitrator cancellation gas reserve before retrying')
  // Pin the checked worst-case cost in the send; do not let the wallet silently choose a larger gas limit/fee.
  let hash: Hex
  try {
    hash = await wallet.sendTransaction({
      to: transaction.to,
      data: transaction.data,
      value: 0n,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
  } catch {
    throw new Error('Ruling cancellation send failed; reconcile the nonce before retrying')
  }
  let receipt: Awaited<ReturnType<CancellationReads['waitForTransactionReceipt']>>
  try {
    receipt = await reads.waitForTransactionReceipt({ hash })
  } catch {
    throw new Error('Ruling cancellation receipt unavailable; reconcile the nonce before retrying')
  }
  if (receipt.status !== 'success') throw new Error('Ruling cancellation reverted')
}

/** Same production path used by main.ts; no sender/key/RPC fallback. */
export function cancellationSender(network: sdk.Network, account: LocalAccount, rpcUrl: string) {
  if (!rpcUrl || rpcUrl === 'unset') throw new Error('Arbitrator cancellation RPC is not configured')
  const wallet = sdk.wallet(network, account, rpcUrl)
  const { publicClient } = sdk.context(network, 'main', rpcUrl)
  return (transaction: sdk.TxRequest) => sendFundedCancellation(wallet, publicClient, transaction)
}

// Keep 0.1 MON after the worst-case fee so the arbitrator can still cancel a stale authorization.
export const ARBITER_MON_FLOOR = sdk.ARBITER_MON_FLOOR
export interface RulingResult {
  readonly txHash: Hex | null
}

function validateRuling(wallet: sdk.Wallet, ctx: sdk.Ctx, send: RulingSend): void {
  const tx = send.transaction
  if (
    tx.chainId !== wallet.chain.id ||
    tx.chainId !== ctx.deployment.chainId ||
    tx.value !== '0' ||
    tx.to.toLowerCase() !== ctx.stack.evaluator.toLowerCase()
  )
    throw new Error('Ruling chain/target/value refused')
  const decoded = decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: tx.data })
  if (decoded.functionName !== 'ruleWithSignature' || decoded.args[0].nonce.toString() !== send.nonce)
    throw new Error('Ruling calldata/nonce refused')
}

/** Receipt and contract nonce are read before every attempt, including a rebroadcast of identical signed bytes. */
async function reconcileRuling(
  ctx: sdk.Ctx,
  account: sdk.Wallet['account'],
  send: RulingSend,
): Promise<(RulingResult & { state: 'landed' | 'cancelled' | 'reverted' }) | undefined> {
  const spent = await ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: sdk.sidequestEvaluatorAbi,
    functionName: 'rulingNonceUsed',
    args: [account.address, BigInt(send.nonce)],
  })
  if (send.hash !== undefined) {
    try {
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash: send.hash })
      if (receipt.status !== 'success') return { state: 'reverted', txHash: receipt.transactionHash }
      if (!spent) throw new Error('Ruling receipt/nonce mismatch')
      return { state: 'landed', txHash: receipt.transactionHash }
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error
    }
  }
  if (!spent) return undefined
  const decoded = decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: send.transaction.data })
  if (decoded.functionName !== 'ruleWithSignature') throw new Error('Ruling calldata refused')
  const decision = await sdk.caseOf(ctx, decoded.args[0].jobId)
  return { state: decision.outcome === 0 ? 'cancelled' : 'landed', txHash: null }
}

async function signFundedRuling(wallet: sdk.Wallet, ctx: sdk.Ctx, send: RulingSend): Promise<RulingSend> {
  const tx = send.transaction
  const [estimate, fees, balance, nonce] = await Promise.all([
    ctx.publicClient.estimateGas({ account: wallet.account, to: tx.to, data: tx.data, value: 0n }),
    ctx.publicClient.estimateFeesPerGas({ chain: wallet.chain, type: 'eip1559' }),
    ctx.publicClient.getBalance({ address: wallet.account.address, blockTag: 'pending' }),
    ctx.publicClient.getTransactionCount({ address: wallet.account.address, blockTag: 'pending' }),
  ])
  const estimated = (estimate * 120n + 99n) / 100n,
    requested = BigInt(tx.gas ?? '0')
  const gas = estimated > requested ? estimated : requested
  if (fees.maxFeePerGas <= 0n || balance < ARBITER_MON_FLOOR + gas * fees.maxFeePerGas)
    throw new Error('Fund the arbitrator MON float: keep at least 0.1 MON plus the ruling gas reserve')
  const raw = await wallet.signTransaction({
    to: tx.to,
    data: tx.data,
    value: 0n,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    type: 'eip1559',
  })
  return { ...send, raw, hash: keccak256(raw) }
}

async function originalRuling(
  ctx: sdk.Ctx,
  wallet: sdk.Wallet,
  journal: RulingJournal,
  intended: RulingSend,
): Promise<RulingSend> {
  const saved = await journal.load(intended.taskId)
  if (saved !== undefined && saved.nonce !== intended.nonce) {
    const previous = await reconcileRuling(ctx, wallet.account, saved)
    if (previous === undefined || previous.state === 'landed')
      throw new Error('Reconcile the original ruling before changing its nonce')
  }
  if (saved?.nonce === intended.nonce && saved.transaction.data !== intended.transaction.data)
    throw new Error('Ruling send changed after persistence')
  return saved?.nonce === intended.nonce ? saved : intended
}

/** Persist intent and signed bytes before sending; retries can only rebroadcast the original transaction. */
export async function sendFundedRuling(
  wallet: sdk.Wallet,
  ctx: sdk.Ctx,
  journal: RulingJournal,
  intended: RulingSend,
): Promise<RulingResult> {
  validateRuling(wallet, ctx, intended)
  if ((await ctx.publicClient.getChainId()) !== intended.transaction.chainId)
    throw new Error('Ruling RPC chain mismatch')
  let send = await originalRuling(ctx, wallet, journal, intended)
  const landed = await reconcileRuling(ctx, wallet.account, send)
  if (landed?.state === 'landed') return { txHash: landed.txHash }
  if (landed !== undefined)
    throw new Error(`Ruling ${landed.state}; cancel/prepare the recorded decision before retrying`)
  await journal.save(send)
  if (send.raw === undefined) {
    send = await signFundedRuling(wallet, ctx, send)
    await journal.save(send)
  }
  return broadcastRuling(ctx, wallet, send)
}

async function broadcastRuling(ctx: sdk.Ctx, wallet: sdk.Wallet, send: RulingSend): Promise<RulingResult> {
  if (send.raw === undefined || send.hash === undefined) throw new Error('Ruling signed journal is incomplete')
  // Recheck the floor for an already-signed retry too; no new transaction or fee is chosen.
  const signed = parseTransaction(send.raw)
  if (
    (await ctx.publicClient.getBalance({ address: wallet.account.address, blockTag: 'pending' })) <
    ARBITER_MON_FLOOR + (signed.gas ?? 0n) * (signed.maxFeePerGas ?? 0n)
  )
    throw new Error('Fund the arbitrator MON float to at least 0.1 MON before retrying')
  try {
    const hash = await ctx.publicClient.sendRawTransaction({ serializedTransaction: send.raw })
    if (hash !== send.hash) throw new Error('Ruling broadcast hash mismatch')
  } catch {
    throw new Error('Ruling send uncertain; reconcile the persisted transaction before retrying')
  }
  let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
  try {
    receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: send.hash })
  } catch {
    throw new Error('Ruling receipt unavailable; reconcile the persisted transaction before retrying')
  }
  if (receipt.status !== 'success')
    throw new Error('Ruling transaction reverted; cancel its authorization before retrying')
  return { txHash: receipt.transactionHash }
}

/** The daemon uses the same funded sender as the unit tests, with a stable persistent journal per account. */
export function rulingSender(
  network: sdk.Network,
  account: LocalAccount,
  rpcUrl: string,
  directory = `${homedir()}/.sidequest-arbiter-rulings`,
) {
  if (!rpcUrl || rpcUrl === 'unset') throw new Error('Arbitrator ruling RPC is not configured')
  const wallet = sdk.wallet(network, account, rpcUrl),
    ctx = sdk.context(network, 'main', rpcUrl)
  const journal = rulingJournal(directory, (taskId) =>
    sdk.hashText(`${ctx.deployment.chainId}:${account.address.toLowerCase()}:${taskId}`),
  )
  return {
    send: (intended: RulingSend) => sendFundedRuling(wallet, ctx, journal, intended),
    async resume(taskId: string): Promise<RulingResult | undefined> {
      const saved = await journal.load(taskId)
      if (saved === undefined) return undefined
      const previous = await reconcileRuling(ctx, account, saved)
      if (previous?.state === 'landed') return { txHash: previous.txHash }
      if (previous !== undefined || saved.raw === undefined) return undefined
      return sendFundedRuling(wallet, ctx, journal, saved)
    },
  }
}

/** All boards share one sequential signer process. Preserve BOARD_URL for single-board operators. */
export function boardUrls(env: NodeJS.ProcessEnv): string[] {
  const value = env.BOARD_URLS ?? env.BOARD_URL
  const urls = [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  ]
  if (!urls.length) throw new Error('BOARD_URLS or BOARD_URL is not set')
  for (const url of urls) if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Invalid board URL')
  return urls
}
