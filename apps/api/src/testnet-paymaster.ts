/** ERC-7677 signer for SidequestTestnetPaymaster. The signer key never leaves this module. */
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  parseAbi,
  slice,
  size,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  AaError,
  type Call,
  type Deployment,
  type Json,
  type JsonRpc,
  type TokenQuote,
  type UserOperation,
  decodeExecuteCalldata,
  delegationManagerAbi,
  field,
  hexField,
  quantity,
  maxTokenCost,
  paymasterData,
  testnetPaymasterHash,
} from '@sidequest/sdk'

const pricingAbi = parseAbi([
  'function exchangeRate() view returns (uint256)',
  'function postOpGas() view returns (uint256)',
])
// The fork exercised 100k validation / 200k postOp successfully; cold postOp measured 125k, empty treasury 152k.
const VERIFICATION_GAS = 100_000n
const POST_OP_GAS = 200_000n
const DUMMY: Hex = `0x${'00'.repeat(65)}`
const quotes = new Map<string, { at: number; quote: TokenQuote }>()
const signingRates = new Map<string, { at: number; count: number }>()
const APPROVE = toFunctionSelector('approve(address,uint256)')
const TRANSFER = toFunctionSelector('transfer(address,uint256)')
const TRANSFER_FROM = toFunctionSelector('transferFrom(address,address,uint256)')

export interface TestnetPaymasterOptions {
  readonly deployment: Deployment
  readonly node: JsonRpc
  readonly signerKey?: string | undefined
  /** Seconds; injectable for hermetic window/cache/rate tests. */
  readonly now?: () => number
}

function address(value: Json | undefined, label: string): Address {
  const hex = hexField(value, label)
  if (size(hex) !== 20 || isAddressEqual(hex, zeroAddress)) throw new AaError('refused', `invalid ${label}`)
  return hex
}

function checkedConfig(options: TestnetPaymasterOptions) {
  const { deployment } = options
  const aa = deployment.aa
  if (deployment.chainId !== 10143 || aa?.paymasterKind !== 'sidequest-testnet')
    throw new AaError('refused', 'the testnet paymaster only serves chain 10143')
  if (aa.paymaster === null) throw new AaError('unavailable', 'the testnet paymaster is not configured')
  return { ...aa, paymaster: aa.paymaster }
}

function checkedParams(params: readonly Json[], options: TestnetPaymasterOptions, quotesRequest: boolean): void {
  const aa = checkedConfig(options)
  if (
    params.length !== (quotesRequest ? 3 : 4) ||
    quantity(params[2], 'chain id') !== 10143n ||
    !isAddressEqual(address(params[1], 'EntryPoint'), aa.entryPoint)
  )
    throw new AaError('refused', 'chain or EntryPoint mismatch')
  if (quotesRequest) {
    const tokens = field(params[0], 'tokens')
    if (!Array.isArray(tokens) || tokens.length !== 1 || !isAddressEqual(address(tokens[0], 'token'), aa.gasToken))
      throw new AaError('refused', 'quote requires the configured gas token')
  } else if (
    field(params[3], 'sponsor') !== undefined ||
    !isAddressEqual(address(field(params[3], 'token'), 'token'), aa.gasToken)
  )
    throw new AaError('refused', 'paymaster context requires the configured gas token')
}

function parsedOperation(raw: Json | undefined, paymaster: Address): UserOperation {
  if (
    field(raw, 'factory') !== undefined ||
    field(raw, 'factoryData') !== undefined ||
    field(raw, 'initCode') !== undefined
  )
    throw new AaError('refused', 'factory deployment is not supported')
  const named = field(raw, 'paymaster')
  if (named !== undefined && !isAddressEqual(address(named, 'paymaster'), paymaster))
    throw new AaError('refused', 'paymaster mismatch')
  const numeric = (name: string) => quantity(field(raw, name), name)
  return {
    sender: address(field(raw, 'sender'), 'sender'),
    nonce: numeric('nonce'),
    callData: hexField(field(raw, 'callData'), 'call data'),
    signature: hexField(field(raw, 'signature'), 'signature'),
    callGasLimit: numeric('callGasLimit'),
    verificationGasLimit: numeric('verificationGasLimit'),
    preVerificationGas: numeric('preVerificationGas'),
    maxFeePerGas: numeric('maxFeePerGas'),
    maxPriorityFeePerGas: numeric('maxPriorityFeePerGas'),
    paymaster,
    paymasterVerificationGasLimit:
      field(raw, 'paymasterVerificationGasLimit') === undefined
        ? VERIFICATION_GAS
        : numeric('paymasterVerificationGasLimit'),
    paymasterPostOpGasLimit:
      field(raw, 'paymasterPostOpGasLimit') === undefined ? POST_OP_GAS : numeric('paymasterPostOpGasLimit'),
  }
}

async function read(node: JsonRpc, to: Address, data: Hex): Promise<bigint> {
  const result = hexField(await node('eth_call', [{ to, data }, 'latest']), 'contract read')
  if (size(result) !== 32) throw new AaError('unavailable', 'invalid contract read')
  return BigInt(result)
}

async function tokenQuote(options: TestnetPaymasterOptions): Promise<TokenQuote> {
  const aa = checkedConfig(options)
  const time = (options.now ?? (() => Math.floor(Date.now() / 1000)))()
  const cached = quotes.get(aa.paymaster.toLowerCase())
  if (cached !== undefined && cached.at <= time && cached.at + 5 > time) return cached.quote
  const [exchangeRate, postOpGas] = await Promise.all([
    read(options.node, aa.paymaster, encodeFunctionData({ abi: pricingAbi, functionName: 'exchangeRate' })),
    read(options.node, aa.paymaster, encodeFunctionData({ abi: pricingAbi, functionName: 'postOpGas' })),
  ])
  if (exchangeRate === 0n) throw new AaError('unavailable', 'paymaster exchange rate is zero')
  const quote = { paymaster: aa.paymaster, exchangeRate, postOpGas }
  quotes.set(aa.paymaster.toLowerCase(), { at: time, quote })
  return quote
}

function checkedCalls(op: UserOperation): readonly Call[] {
  const calls = decodeExecuteCalldata(op.callData)
  if (calls === null || calls.length === 0 || calls.some((call) => call.value !== 0n))
    throw new AaError('refused', 'a DeleGator batch without native value is required')
  return calls
}

function checkedGas(op: UserOperation): void {
  if (
    (op.paymasterPostOpGasLimit ?? 0n) < 160_000n ||
    (op.paymasterVerificationGasLimit ?? 0n) === 0n ||
    op.maxPriorityFeePerGas > op.maxFeePerGas
  )
    throw new AaError('refused', 'invalid paymaster gas limits or fees')
}

/** Decodable callData alone is not enough: arbitrary smart accounts may ignore it after obtaining a quote. */
async function checkedAccount(options: TestnetPaymasterOptions, raw: Json | undefined, sender: Address): Promise<void> {
  const delegator = options.deployment.delegation.delegator
  const auth = field(raw, 'eip7702Auth')
  if (auth !== undefined) {
    if (
      quantity(field(auth, 'chainId'), 'authorization chain') !== 10143n ||
      !isAddressEqual(address(field(auth, 'address'), 'authorization delegate'), delegator)
    )
      throw new AaError('refused', '7702 authorization must use the configured DeleGator and chain')
    // The bundler verifies the signed authorization before including it; a bad signature cannot change account code.
    return
  }
  const code = hexField(await options.node('eth_getCode', [sender, 'latest']), 'account code')
  if (code.toLowerCase() !== `0xef0100${delegator.slice(2).toLowerCase()}`)
    throw new AaError('refused', 'sender must use the configured DeleGator or carry its 7702 authorization')
}

/** A gas pull counts only in the first call, to the configured manager, with single default transfer execution. */
async function gasPull(options: TestnetPaymasterOptions, op: UserOperation, call: Call | undefined): Promise<bigint> {
  const aa = checkedConfig(options)
  if (call === undefined || !isAddressEqual(call.to, options.deployment.delegation.manager)) return 0n
  const decoded = decodeFunctionData({ abi: delegationManagerAbi, data: call.data })
  if (decoded.functionName !== 'redeemDelegations') return 0n
  const [contexts, modes, executions] = decoded.args
  if (contexts.length !== 1 || modes.length !== 1 || executions.length !== 1 || BigInt(modes[0]!) !== 0n)
    throw new AaError('refused', 'gas funding requires one default execution')
  const execution = executions[0]!
  if (
    size(execution) < 52 ||
    !isAddressEqual(slice(execution, 0, 20), aa.gasToken) ||
    BigInt(slice(execution, 20, 52)) !== 0n
  )
    throw new AaError('refused', 'gas funding execution mismatch')
  const transfer = decodeFunctionData({ abi: erc20Abi, data: slice(execution, 52) })
  if (transfer.functionName !== 'transfer' || !isAddressEqual(transfer.args[0], op.sender))
    throw new AaError('refused', 'gas funding must transfer the gas token to the sender')
  // Execute the real permission checks, operator balance/allowance and enforcer budgets before counting this pull.
  await options.node('eth_call', [{ from: op.sender, to: call.to, data: call.data }, 'latest'])
  return transfer.args[1]
}

/** Track gas-token spends and the last paymaster approval, so an earlier sufficient approval cannot hide revocation. */
function tokenEffects(
  call: Call,
  sender: Address,
  paymaster: Address,
  allowance: bigint,
): { debit: bigint; allowance: bigint } {
  const selector = slice(call.data, 0, 4)
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
  if (selector === APPROVE && decoded.functionName === 'approve')
    return { debit: 0n, allowance: isAddressEqual(decoded.args[0], paymaster) ? decoded.args[1] : allowance }
  if (selector === TRANSFER && decoded.functionName === 'transfer')
    return { debit: isAddressEqual(decoded.args[0], sender) ? 0n : decoded.args[1], allowance }
  if (selector === TRANSFER_FROM && decoded.functionName === 'transferFrom')
    return {
      debit: isAddressEqual(decoded.args[0], sender) && !isAddressEqual(decoded.args[1], sender) ? decoded.args[2] : 0n,
      allowance,
    }
  throw new AaError('refused', 'unsupported gas-token call')
}

async function checkFunding(
  options: TestnetPaymasterOptions,
  op: UserOperation,
  calls: readonly Call[],
  cost: bigint,
): Promise<void> {
  const aa = checkedConfig(options)
  const [currentBalance, currentAllowance] = await Promise.all([
    read(
      options.node,
      aa.gasToken,
      encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [op.sender] }),
    ),
    read(
      options.node,
      aa.gasToken,
      encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [op.sender, aa.paymaster] }),
    ),
  ])
  let balance = currentBalance
  if (balance < cost) {
    const pulled = await gasPull(options, op, calls[0])
    if (pulled < cost) throw new AaError('refused', 'insufficient gas-token balance or first-call gas pull')
    balance += pulled
  }
  let allowance = currentAllowance
  for (const call of calls) {
    if (!isAddressEqual(call.to, aa.gasToken)) continue
    const effects = tokenEffects(call, op.sender, aa.paymaster, allowance)
    balance -= effects.debit
    allowance = effects.allowance
  }
  if (balance < cost || allowance < cost)
    throw new AaError('refused', 'gas-token balance and paymaster allowance must cover the cost')
}

function signingRate(sender: Address, time: number): void {
  for (const [key, rate] of signingRates) if (rate.at + 60 <= time) signingRates.delete(key)
  const key = sender.toLowerCase()
  const rate = signingRates.get(key) ?? { at: time, count: 0 }
  if (rate.count >= 12 || signingRates.size >= 10_000)
    throw new AaError('refused', 'paymaster signing rate limit exceeded')
  rate.count++
  signingRates.set(key, rate)
}

function signingAccount(key: string | undefined) {
  try {
    if (key !== undefined && /^0x[0-9a-fA-F]{64}$/.test(key)) {
      // SAFETY: key format is checked here; viem rejects zero and out-of-range scalars.
      return privateKeyToAccount(key as Hex)
    }
  } catch {
    /* Invalid secret disables the service. */
  }
  throw new AaError('unavailable', 'testnet paymaster signer unavailable')
}

const reply = (
  paymaster: Address,
  op: UserOperation,
  validUntil: bigint,
  validAfter: bigint,
  signature: Hex,
): Json => ({
  paymaster,
  paymasterData: paymasterData({ validUntil, validAfter }, signature),
  paymasterVerificationGasLimit: toHex(op.paymasterVerificationGasLimit ?? VERIFICATION_GAS),
  paymasterPostOpGasLimit: toHex(op.paymasterPostOpGasLimit ?? POST_OP_GAS),
})

/** Quote caching and sender limits are best-effort per isolate, with no durable/global quota claim. */
export function testnetPaymasterRpc(options: TestnetPaymasterOptions): JsonRpc {
  return async (method, params) => {
    const aa = checkedConfig(options)
    const quoteRequest = method === 'pimlico_getTokenQuotes'
    checkedParams(params, options, quoteRequest)
    if (quoteRequest) {
      const quote = await tokenQuote(options)
      return {
        quotes: [
          {
            paymaster: aa.paymaster,
            token: aa.gasToken,
            exchangeRate: toHex(quote.exchangeRate),
            postOpGas: toHex(quote.postOpGas),
          },
        ],
      }
    }
    if (method !== 'pm_getPaymasterStubData' && method !== 'pm_getPaymasterData')
      throw new AaError('refused', 'unsupported paymaster method')
    const op = parsedOperation(params[0], aa.paymaster)
    const calls = checkedCalls(op)
    const time = (options.now ?? (() => Math.floor(Date.now() / 1000)))()
    const validUntil = BigInt(time + 600)
    const validAfter = BigInt(Math.max(0, time - 60))
    if (method === 'pm_getPaymasterStubData')
      return reply(
        aa.paymaster,
        { ...op, paymasterVerificationGasLimit: VERIFICATION_GAS, paymasterPostOpGasLimit: POST_OP_GAS },
        validUntil,
        validAfter,
        DUMMY,
      )
    checkedGas(op)
    const signer = signingAccount(options.signerKey)
    signingRate(op.sender, time)
    await checkedAccount(options, params[0], op.sender)
    const cost = maxTokenCost(op, await tokenQuote(options))
    if (cost > aa.maxCostPerOp) throw new AaError('ceiling', 'gas-token cost exceeds the configured ceiling')
    await checkFunding(options, op, calls, cost)
    const signature = await signer.signMessage({
      message: { raw: testnetPaymasterHash(op, 10143, aa.paymaster, validUntil, validAfter) },
    })
    return reply(aa.paymaster, op, validUntil, validAfter, signature)
  }
}
