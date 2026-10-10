/**
 * The hosted board (spec §5): one service behind both the REST API and the MCP tools. It coordinates. Every
 * money-moving step of the protocol comes back as an unsigned transaction or EIP-712 message for the caller's own
 * wallet (cast, MetaMask agent wallet, Privy, a browser), and every chain fact is read from the chain, never taken from
 * a client's claim (spec §3: a board receipt never overrides chain state). The one exception is the execution budget
 * (ADR-0005, `budget.ts`): a creator may add the board's signer to their Privy wallet, bounded by their own policy.
 *
 * At most one economic effect per operation (R114-07): an operation record is written before a money-moving
 * transaction is handed out and reconciled from the chain (receipt, or the listing itself) afterwards; the
 * contracts refuse the duplicates a retry could cause (reused `termsHash`, used selection nonce, spent
 * authorisation nonce).
 */
import * as sdk from '@sidequest/sdk'
import { delegationPositions, positionFilters, type DelegationSnapshot, type PositionFilters } from './staking.ts'
import {
  type Address,
  type Hex,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  fromRlp,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  pad,
  parseUnits,
  zeroAddress,
} from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import { recoverAuthorizationAddress } from 'viem/utils'
import { BudgetDesk, nativeSymbol } from './budget.ts'
import { type NamedSponsorEntry, SponsorDesk } from './sponsor.ts'
import * as sidequest from './sidequest.ts'
import { confirmedOperationEvents, vaultOperationEvent } from './receipts.ts'
import { confirmOperationEvent, consumedOperationEvents, receiptTimestamp } from './operation-receipts.ts'
import { RelaySender, type RelayRequest } from './relay.ts'
import { collectActions, type CollectSnapshot } from './collect.ts'
import * as v1Tools from './v1-tools.ts'
import { miningEpoch, miningProof, type MiningSource } from './mining.ts'
import { type DisputeBundle, type ViolationName, bundleHash, rulingRefusal } from './arbitration.ts'
import { type DisputeBundleReply, type DisputeThreadReader, withDisputeThread } from './dispute-thread.ts'
import { type GitHubApp, checkRuns, installationToken, repoSlug } from './github.ts'
import type { ModelEndpoint } from './model.ts'
import { screenOffer } from './screening.ts'
import { creatorSelectionProjection } from './selection.ts'
import { type NextAction, publisherFunding, publisherNextAction, settlementNote } from './publisher-view.ts'
import { assertAgentEnvelope, assertExactAgentTypedData } from './agent-signing-scope.ts'
import { typedDataJson } from './typed-data.ts'
import { BoardError } from './board-error.ts'
import type { HostedCreatorFacts, HostedCreatorQuery } from './hosted-creators.ts'
import {
  type ApplicationRow,
  type OperationRow,
  type QuoteRequestRow,
  type QuoteRow,
  type RulingRow,
  type SelectionRow,
  type Sql,
  type TaskRow,
  migrate,
} from './store.ts'
import {
  type CallBudget,
  type ExecutionBudget,
  type OfferTerms,
  TermsError,
  callFunction,
  canonicalJson,
  parseTerms,
  termsHash,
  validateOffer,
} from './terms.ts'
import {
  type Deliverable,
  type DeliverableCheck,
  type DeliverableSpec,
  DELIVERABLE_KINDS,
  DeliverableError,
  checkDeliverable,
  deliverableHash as hashDeliverable,
  legacyColumns,
  parseDeliverable,
  specOf,
  validateSpec,
} from './deliverable.ts'

/** A signed authorization as `cast wallet sign-auth` prints it: RLP of [chainId, address, nonce, yParity, r, s]. */
function authorizationFromRlp(rlp: string): Record<string, unknown> {
  let items: unknown
  try {
    items = fromRlp(rlp as Hex, 'hex')
  } catch {
    throw new BoardError(
      'invalid',
      'authorization must be the signed authorization (an object, or the RLP hex `cast wallet sign-auth` prints)',
    )
  }
  if (!Array.isArray(items) || items.length !== 6 || !items.every((x) => typeof x === 'string')) {
    throw new BoardError('invalid', 'the RLP authorization must be [chainId, address, nonce, yParity, r, s]')
  }
  const [chainId, address, nonce, yParity, r, sig] = items as [Hex, Hex, Hex, Hex, Hex, Hex]
  return {
    chainId: rlpInt(chainId),
    address,
    nonce: rlpInt(nonce),
    yParity: rlpInt(yParity),
    r: pad(r, { size: 32 }),
    s: pad(sig, { size: 32 }),
  }
}

/** RLP writes zero as empty bytes. */
const rlpInt = (x: Hex) => (x === '0x' ? '0' : x)

export { BoardError }

export interface BoardConfig {
  readonly network: sdk.Network
  /** The chain context for the configured v1 main stack. */
  readonly contexts: Partial<Record<sdk.StackName, sdk.Ctx>>
  /** SIWE domain and URI: the host and origin the API is served from. */
  readonly domain: string
  readonly uri: string
  /** Where manifests are publicly readable: `${manifestBaseUrl}/${termsHash}.json`. */
  readonly manifestBaseUrl: string
  readonly now?: () => number
  readonly disputeThread?: DisputeThreadReader
  /** Checked, read-only discovery across every hosted board and pair; absent means Collect is unavailable. */
  readonly collectSnapshot?: (wallet: Address) => Promise<CollectSnapshot>
  readonly delegationSnapshot?: (filters: PositionFilters) => Promise<DelegationSnapshot>
  readonly miningSource?: MiningSource
  /** Used for the one-time submission check of a deliverable (ADR-0006); defaults to the global fetch. */
  readonly fetch?: typeof fetch
  /**
   * The attester (spec §5): a registered verifier key that signs evidence about GitHub check runs, the relay that
   * sends `attachEvidence` (it holds no authority: the evaluator checks the attester's signature), and the GitHub
   * App it reads with. Absent: evidence is unavailable and says so.
   */
  /** Jev's model endpoint (advisory screening at publish); absent → "unscreened". */
  readonly screening?: ModelEndpoint
  /**
   * The relay that sends signed rulings (`ruleWithSignature`). It holds no authority: the evaluator checks the
   * arbitrator's signature. Absent: `submit_ruling` returns the transaction for anyone to send.
   */
  readonly relay?: { readonly account: import('viem').LocalAccount; readonly rpcUrl: string }
  /** Hosted tenants route every relay send to the shared sponsorship object's durable nonce ledger. */
  readonly relaySend?: (request: RelayRequest) => Promise<Hex>
  /**
   * Hosted posters, read in the object that keeps hosted agents: the agent ID behind a wallet and what one live
   * weekly-budget grant can still fund. Absent: no poster is hosted (local and test boards).
   */
  readonly hostedCreators?: (query: HostedCreatorQuery) => Promise<HostedCreatorFacts>
  /**
   * ADR-0019: accept quote requests and offers only from agents, a hosted agent's wallet or the wallet of the ERC-8004
   * agent the caller names. Off: anyone may post, and the posting agent is still recorded when it resolves.
   */
  readonly requirePosterAgent?: boolean
  readonly evidence?: {
    readonly attester: import('viem').LocalAccount
    readonly relay: import('viem').LocalAccount
    readonly rpcUrl: string
    readonly github?: GitHubApp
  }
}

/** An unsigned transaction for the caller's wallet: `cast send <to> <data>`, or `eth_sendTransaction`. */
export type TxRequest = sdk.TxRequest

export interface TaskPreparation {
  taskId: string
  termsHash: Hex
  screening: Awaited<ReturnType<typeof screenOffer>>
  manifestUrl: string
  manifest: string
  transactions: TxRequest[]
  applicationId?: string
  next: string
}
interface QuotePreparation {
  requestId: string
  requestHash: Hex
  status: string
  next: string
}
/** The public request list's poster reads (balances, hosted grants) give up after this; the field then says null. */
const POSTER_READ_MS = 4000

/** A read's value, or undefined if it fails or outlasts `ms`: an advisory field never holds up or fails its list. */
async function settleWithin<T>(read: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([read.catch(() => undefined), late])
  } finally {
    clearTimeout(timer)
  }
}

/** How long a closed or picked quote request stays in the public list's `recent` view. */
const RECENT_REQUESTS = 7 * 86_400

interface QuoteRequestRead {
  requestId: string
  requestHash: string
  taskId: string | null
  status: string
  createdAt: number
  quotesCount: number
  creatorAgentId?: string | null
  budgetCovered?: boolean | null
  invite: { agentId: string; wallet: string } | null
  [key: string]: unknown
}

function isQuoteInvite(value: unknown): value is { agentId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'agentId' in value &&
    typeof value.agentId === 'string' &&
    /^[1-9]\d*$/.test(value.agentId) &&
    BigInt(value.agentId) < 2n ** 256n
  )
}

/** An EIP-712 message for the caller's wallet: `cast wallet sign --data '<json>'`, or `eth_signTypedData_v4`. */
export interface SignRequest {
  readonly description: string
  readonly typedData: string
}

export interface Caller {
  readonly address?: Address
}

const SESSION_SECONDS = 24 * 3600
const NONCE_SECONDS = 10 * 60

function randomId(bytes = 16): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomUint(bytes: number): bigint {
  return crypto.getRandomValues(new Uint8Array(bytes)).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n)
}

const idempotencyKey = (key: unknown): string | undefined => {
  if (key === undefined) return undefined
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
    throw new BoardError('invalid', 'idempotencyKey must be 1-128 letters, digits, underscores or hyphens')
  return key
}

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase()

/**
 * An execution budget as a caller asks for it (decimal cap). An advance names the ERC-20 `token` the worker draws; a
 * call budget names the contract `target` and the one allowed `function`, and caps the call's native value.
 */
export interface BudgetInput {
  kind: 'advance' | 'call'
  token?: string
  target?: string
  function?: string
  cap: string
  expiresAt?: number
}

function normalizeTags(value: unknown): sdk.JobTag[] {
  try {
    return sdk.jobTags(value)
  } catch (error) {
    throw new BoardError('invalid', (error as Error).message)
  }
}

/** A local validation refusal; provider error text never becomes a trusted reply. */
function invalidTerms(error: unknown): BoardError {
  return new BoardError('invalid', error instanceof TermsError ? error.message : 'the offer terms are invalid')
}

/** The spec as frozen into terms: kinds de-duplicated in canonical order, an empty target dropped. */
function normalSpec(spec: DeliverableSpec): DeliverableSpec {
  const problem = validateSpec(spec)
  if (problem !== undefined) throw new BoardError('invalid', `deliverable: ${problem}`)
  const target = spec.target?.trim()
  return {
    accepts: DELIVERABLE_KINDS.filter((k) => (spec.accepts as readonly string[]).includes(k)),
    ...(target === undefined || target === '' ? {} : { target }),
  }
}

/** A recorded deliverable as read back: its descriptor (legacy rows are git) and the submission check, if any. */
function deliverableView<
  R extends {
    repo: string
    branch: string
    sha: string
    kind: string | null
    descriptor_json: string | null
    check_json: string | null
  },
>(r: R) {
  const { kind: _kind, descriptor_json, check_json, ...rest } = r
  const descriptor: Deliverable =
    descriptor_json === null
      ? { kind: 'git', url: r.repo, ref: r.branch, sha: r.sha }
      : (JSON.parse(descriptor_json) as Deliverable)
  return { ...rest, descriptor, check: check_json === null ? null : (JSON.parse(check_json) as DeliverableCheck) }
}

export class Board {
  readonly #sql: Sql
  readonly #config: BoardConfig

  readonly #budget: BudgetDesk
  #sponsor: SponsorDesk | undefined
  #relaySender: RelaySender | undefined

  constructor(sql: Sql, config: BoardConfig) {
    this.#sql = sql
    this.#config = config
    migrate(sql)
    this.#budget = new BudgetDesk({
      sql,
      now: () => this.#now(),
      fail: (code, message) => new BoardError(code, message),
      taskState: async (taskId) => {
        const task = this.#task(taskId)
        const view = await this.#chainView(task)
        return {
          task,
          terms: parseTerms(task.terms_json),
          status: view.status,
          provider: view.provider,
          ctx: this.#taskCtx(task),
        }
      },
    })
  }

  // -----------------------------------------------------------------------------------------------
  // Execution budget (ADR-0009)
  // -----------------------------------------------------------------------------------------------

  budgetGrantPrepare(caller: Caller, input: { taskId: string }) {
    return this.#budget.grantPrepare(this.#requireCaller(caller), input)
  }

  budgetGrantConfirm(caller: Caller, input: { taskId: string; signature: string }) {
    return this.#budget.grantConfirm(this.#requireCaller(caller), input)
  }

  getBudget(caller: Caller, input: { taskId: string }) {
    return this.#budget.getBudget(this.#requireCaller(caller), input)
  }

  spendBudget(caller: Caller, input: { taskId: string; amount: string; note?: string }) {
    return this.#budget.spend(this.#requireCaller(caller), input)
  }

  spendBudgetCall(caller: Caller, input: { taskId: string; data: string; value?: string; note?: string }) {
    return this.#budget.spendCall(this.#requireCaller(caller), input)
  }

  revokeBudget(caller: Caller, input: { taskId: string }) {
    return this.#budget.revoke(this.#requireCaller(caller), input)
  }

  #sponsorDesk(caller: Caller, wallet: string): SponsorDesk {
    const me = this.#requireCaller(caller)
    if (!isAddress(wallet) || !eq(me, wallet))
      throw new BoardError('forbidden', 'sponsorship requires the authenticated wallet’s own address')
    this.#sponsor ??= new SponsorDesk({
      sql: this.#sql,
      ctx: this.#ctx('main'),
      now: () => this.#now(),
      ...(this.#config.relay === undefined ? {} : { relay: this.#config.relay }),
      fail: (code, message) => new BoardError(code, message),
    })
    return this.#sponsor
  }
  #idempotent<T>(caller: Address, operation: string, key: unknown): T | undefined {
    const actionKey = idempotencyKey(key)
    if (actionKey === undefined) return undefined
    const [row] = this.#sql.all<{ result_json: string }>(
      'SELECT result_json FROM hosted_idempotency WHERE caller=? AND operation=? AND action_key=?',
      caller.toLowerCase(),
      operation,
      actionKey,
    )
    return row === undefined ? undefined : (JSON.parse(row.result_json) as T)
  }
  #remember<T>(caller: Address, operation: string, key: unknown, result: T): T {
    const actionKey = idempotencyKey(key)
    if (actionKey !== undefined)
      this.#sql.run(
        'INSERT OR IGNORE INTO hosted_idempotency (caller,operation,action_key,result_json,created_at) VALUES (?,?,?,?,?)',
        caller.toLowerCase(),
        operation,
        actionKey,
        JSON.stringify(result),
        this.#now(),
      )
    return result
  }
  #persist<T>(write: () => T): T {
    if (this.#sql.atomic === undefined) throw new BoardError('chain', 'atomic board storage is unavailable')
    return this.#sql.atomic(write)
  }
  sponsorStatus(caller: Caller, input: { wallet: string }) {
    return this.#sponsorDesk(caller, input.wallet).status(input.wallet)
  }
  sponsorPrepare(caller: Caller, input: { wallet: string }) {
    return this.#sponsorDesk(caller, input.wallet).prepare(input.wallet)
  }
  sponsorConfirm(caller: Caller, input: { wallet: string; signature: string }) {
    return this.#sponsorDesk(caller, input.wallet).confirm(input.wallet, input.signature)
  }
  sponsorRevoke(caller: Caller, input: { wallet: string }) {
    return this.#sponsorDesk(caller, input.wallet).revoke(input.wallet)
  }
  sponsorSubmit(caller: Caller, input: { wallet: string; entries: readonly NamedSponsorEntry[]; key: string }) {
    return this.#sponsorDesk(caller, input.wallet).submit(input.wallet, input.entries, input.key)
  }
  sponsorOperation(caller: Caller, input: { wallet: string; operationId: string }) {
    return this.#sponsorDesk(caller, input.wallet).operation(input.wallet, input.operationId)
  }

  /** Internal binding RPC only; never included in the public tool registry. */
  async relayTransaction(request: RelayRequest): Promise<Hex> {
    const relay = this.#config.relay
    if (relay === undefined) throw new BoardError('conflict', 'the relay is unavailable')
    this.#relaySender ??= new RelaySender(this.#sql, this.#ctx('main'), relay.account, relay.rpcUrl, () => this.#now())
    return (await this.#relaySender.submit(request)).transactionHash
  }
  #sendRelay(request: RelayRequest): Promise<Hex> {
    return this.#config.relaySend === undefined ? this.relayTransaction(request) : this.#config.relaySend(request)
  }

  async topUp(caller: Caller, input: { taskId: string; amount: string }) {
    const me = this.#requireCaller(caller),
      task = this.#task(input.taskId)
    const prepared = await v1Tools.prepareTopUp(
      this.#taskCtx(task),
      me,
      this.#jobId(task),
      input.amount,
      (code, message) => new BoardError(code, message),
    )
    const operationId = this.#operation(task.id, 'top-up', me, { amount: prepared.amount })
    return { operationId, ...prepared }
  }
  #vaultAccount(input: string | undefined, fallback: Address): Address {
    if (input === undefined) return fallback
    if (typeof input !== 'string' || !isAddress(input)) throw new BoardError('invalid', 'account must be an address')
    return getAddress(input)
  }
  async stake(caller: Caller, input: { amount: string; account?: string }) {
    const me = this.#requireCaller(caller)
    const prepared = await v1Tools.prepareStake(
      this.#ctx('main'),
      me,
      input.amount,
      (code, message) => new BoardError(code, message),
      this.#vaultAccount(input.account, me),
    )
    const operationId = this.#operation(`vault:${prepared.account.toLowerCase()}:${me.toLowerCase()}`, 'stake', me, {
      account: prepared.account,
      delegator: me,
      payer: me,
      amount: prepared.amount,
      shares: prepared.shares,
      token: prepared.token,
      vault: this.#ctx('main').deployment.sidequest!.vault,
    })
    return { operationId, ...prepared }
  }
  async requestUnstake(caller: Caller, input: { amount: string; account?: string }) {
    const me = this.#requireCaller(caller)
    const prepared = await v1Tools.prepareUnstake(
      this.#ctx('main'),
      me,
      input.amount,
      (code, message) => new BoardError(code, message),
      this.#vaultAccount(input.account, me),
    )
    const operationId = this.#operation(
      `vault:${prepared.account.toLowerCase()}:${me.toLowerCase()}`,
      'request-unstake',
      me,
      {
        account: prepared.account,
        delegator: me,
        amount: prepared.amount,
        shares: prepared.shares,
        token: prepared.token,
        vault: this.#ctx('main').deployment.sidequest!.vault,
      },
    )
    return { operationId, ...prepared }
  }
  async withdrawStake(caller: Caller, input: { account?: string } = {}) {
    const me = this.#requireCaller(caller)
    const prepared = await v1Tools.prepareStakeWithdrawal(
      this.#ctx('main'),
      me,
      (code, message) => new BoardError(code, message),
      this.#vaultAccount(input.account, me),
    )
    const operationId = this.#operation(
      `vault:${prepared.account.toLowerCase()}:${me.toLowerCase()}`,
      'withdraw-stake',
      me,
      {
        account: prepared.account,
        delegator: me,
        amount: prepared.amount,
        shares: prepared.shares,
        token: prepared.token,
        vault: this.#ctx('main').deployment.sidequest!.vault,
      },
    )
    return { operationId, ...prepared }
  }
  async cancelUnstake(caller: Caller, input: { account?: string } = {}) {
    const me = this.#requireCaller(caller)
    const prepared = await v1Tools.prepareCancelUnstake(
      this.#ctx('main'),
      me,
      (code, message) => new BoardError(code, message),
      this.#vaultAccount(input.account, me),
    )
    const operationId = this.#operation(
      `vault:${prepared.account.toLowerCase()}:${me.toLowerCase()}`,
      'cancel-unstake',
      me,
      {
        account: prepared.account,
        delegator: me,
        shares: prepared.shares,
        token: prepared.token,
        vault: this.#ctx('main').deployment.sidequest!.vault,
      },
    )
    return { operationId, ...prepared }
  }
  async getStake(_caller: Caller, input: { wallet?: string; account?: string }) {
    const wallet = input.wallet ?? _caller.address ?? input.account
    if (typeof wallet !== 'string' || !isAddress(wallet))
      throw new BoardError('invalid', 'wallet or account must be an address')
    const ctx = this.#ctx('main'),
      h = v1Tools.requireV1(ctx, (code, message) => new BoardError(code, message))
    const account = this.#vaultAccount(input.account, getAddress(wallet))
    const blockNumber = await ctx.publicClient.getBlockNumber()
    const [backing, position] = await Promise.all([
      sdk.getBacking(ctx, account, { blockNumber }),
      sdk.getPosition(ctx, account, getAddress(wallet), { blockNumber }),
    ])
    return {
      token: h.factory,
      vault: h.vault,
      account,
      delegator: getAddress(wallet),
      blockNumber: backing.blockNumber,
      assets: backing.assets.toString(),
      staked: backing.active.toString(),
      reserved: backing.reserved.toString(),
      available: backing.available.toString(),
      queued: backing.queued.toString(),
      unstaking: position.queued.toString(),
      unlockAt: position.unlockAt,
      shares: position.shares.toString(),
      queuedShares: position.queuedShares.toString(),
      tier: backing.tier,
    }
  }
  async listDelegations(caller: Caller, input: { wallet?: string; account?: string }) {
    const filters = positionFilters(input, caller.address, (message) => new BoardError('invalid', message))
    if (this.#config.delegationSnapshot === undefined)
      throw new BoardError('chain', 'the delegation index is unavailable')
    const ctx = this.#ctx('main')
    v1Tools.requireV1(ctx, (code, message) => new BoardError(code, message))
    return delegationPositions(ctx, await this.#config.delegationSnapshot(filters))
  }
  async feeQuote(_caller: Caller, input: { taskId: string; worker: string }) {
    if (typeof input.worker !== 'string' || !isAddress(input.worker))
      throw new BoardError('invalid', 'worker must be an address')
    const task = this.#task(input.taskId),
      ctx = this.#taskCtx(task)
    v1Tools.requireV1(ctx, (code, message) => new BoardError(code, message))
    const [feeBps, fee, net] = await sdk.quoteActivation(ctx, this.#jobId(task), getAddress(input.worker))
    return { feeBps, fee: fee.toString(), net: net.toString() }
  }
  async collectActions(_caller: Caller, input: { wallet: string }) {
    if (typeof input.wallet !== 'string' || !isAddress(input.wallet))
      throw new BoardError('invalid', 'wallet must be an address')
    if (this.#config.collectSnapshot === undefined) throw new BoardError('chain', 'the collect index is unavailable')
    const wallet = getAddress(input.wallet)
    return collectActions(
      this.#ctx('main'),
      wallet,
      await this.#config.collectSnapshot(wallet),
      this.#config.miningSource,
    )
  }
  async miningProof(_caller: Caller, input: { wallet: string; epoch: string }) {
    if (typeof input.wallet !== 'string' || !isAddress(input.wallet))
      throw new BoardError('invalid', 'wallet must be an address')
    try {
      miningEpoch(input.epoch)
    } catch {
      throw new BoardError('invalid', 'epoch must be a canonical uint256 decimal string')
    }
    if (this.#config.miningSource === undefined) throw new BoardError('chain', 'mining artifacts are unavailable')
    return miningProof(this.#ctx('main'), getAddress(input.wallet), input.epoch, this.#config.miningSource)
  }

  /**
   * The descriptor a worker submits (ADR-0006): `deliverable`, or the legacy `{repo, branch, sha}` as git. Refused
   * when the offer does not accept its kind.
   */
  #acceptedDeliverable(
    terms: OfferTerms,
    input: { deliverable?: unknown; repo?: string; branch?: string; sha?: string },
  ): Deliverable {
    let d: Deliverable
    try {
      d = parseDeliverable(input.deliverable ?? { kind: 'git', url: input.repo, ref: input.branch, sha: input.sha })
    } catch (e) {
      if (e instanceof DeliverableError) throw new BoardError('invalid', e.message)
      throw e
    }
    const spec = specOf(terms)
    if (!spec.accepts.includes(d.kind)) {
      throw new BoardError(
        'invalid',
        `this offer accepts ${spec.accepts.join(', ')} deliverables, not ${d.kind}${spec.target === undefined ? '' : ` (target: ${spec.target})`}`,
      )
    }
    return d
  }

  /** The one-time, advisory submission check; the board keeps the result, never the work. */
  #checkDeliverable(d: Deliverable): Promise<DeliverableCheck> {
    const contexts = Object.values(this.#config.contexts).filter((c): c is sdk.Ctx => c !== undefined)
    return checkDeliverable(d, {
      fetch: this.#config.fetch ?? ((...a) => fetch(...a)),
      now: () => this.#now(),
      chain: (chainId) => contexts.find((c) => c.deployment.chainId === chainId)?.publicClient,
    })
  }

  #now(): number {
    return this.#config.now?.() ?? Math.floor(Date.now() / 1000)
  }

  #ctx(stack: string): sdk.Ctx {
    const ctx = this.#config.contexts[stack as sdk.StackName]
    if (ctx === undefined)
      throw new BoardError('invalid', `stack "${stack}" is not deployed on ${this.#config.network}`)
    return ctx
  }

  /**
   * The chain context of a task's own pair: the Holding its frozen terms name. After a stacks-only redeploy a task
   * published on an earlier pair stays there (its listing, bonds and windows live on it), so its stack name alone
   * would point at the wrong contracts.
   */
  #findTaskCtx(task: TaskRow): sdk.Ctx | undefined {
    const binding = parseTerms(task.terms_json).deployment
    const holding = binding.holding
    const current = Object.values(this.#config.contexts).find((c) => c !== undefined && eq(c.stack.holding, holding))
    if (current !== undefined) return current
    return undefined
  }

  #taskCtx(task: TaskRow): sdk.Ctx {
    const ctx = this.#findTaskCtx(task)
    if (ctx === undefined)
      throw new BoardError(
        'unavailable',
        'archived task: its Holding is no longer configured; records and evidence are preserved, but live reads and actions are unavailable',
      )
    return ctx
  }

  readonly #pausedCache = new Map<string, { at: number; paused: boolean }>()
  /** What can fund a budgeted request's pick, per stack:creator:token, for 30 s: the anonymous list stays cheap. */
  readonly #coverCache = new Map<string, { at: number; funds: bigint }>()
  /** The hosted agent behind a poster's wallet (null: not hosted), for 5 min; a wallet binding never changes. */
  readonly #creatorCache = new Map<string, { at: number; agentId: string | null }>()

  /** The core's pause flag, read at most every 15 s. While paused every core call reverts, so the board hands out none. */
  async paused(stack: sdk.StackName = 'main'): Promise<boolean> {
    return this.#paused(this.#ctx(stack))
  }

  async #paused(ctx: sdk.Ctx): Promise<boolean> {
    const key = ctx.deployment.core.toLowerCase()
    const hit = this.#pausedCache.get(key)
    if (hit !== undefined && this.#now() - hit.at < 15) return hit.paused
    const paused = await ctx.publicClient.readContract({
      address: ctx.deployment.core,
      abi: sdk.coreAbi,
      functionName: 'paused',
    })
    this.#pausedCache.set(key, { at: this.#now(), paused })
    return paused
  }

  async #requireUnpaused(stack: string | TaskRow): Promise<void> {
    if (await this.#paused(typeof stack === 'string' ? this.#ctx(stack) : this.#taskCtx(stack))) {
      throw new BoardError(
        'conflict',
        'the core contract is paused by its admin; nothing can move until it is unpaused (README, Trust)',
      )
    }
  }

  #tx(ctx: sdk.Ctx, description: string, to: Address, data: Hex, gas?: bigint): TxRequest {
    return sidequest.transaction(ctx, description, to, data, gas)
  }

  #requireCaller(caller: Caller): Address {
    if (caller.address === undefined) {
      throw new BoardError(
        'unauthenticated',
        'Sign in first: auth_challenge, sign the message with your wallet, auth_login.',
      )
    }
    return caller.address
  }

  /**
   * ADR-0019: the ERC-8004 agent posting as `creator`: the one the caller names, when that agent's wallet is the
   * caller's, else the hosted agent behind the wallet. Null when neither resolves; a board that requires poster agents
   * then refuses the post. A failed hosted lookup is unavailable there, never a refusal.
   */
  async #posterAgent(ctx: sdk.Ctx, creator: Address, agentId: string | undefined): Promise<string | null> {
    if (agentId !== undefined) {
      if (!/^\d{1,78}$/.test(agentId)) throw new BoardError('invalid', 'agentId must be a decimal ERC-8004 agent ID')
      const wallet = await ctx.publicClient.readContract({
        address: ctx.deployment.identity,
        abi: sdk.identityAbi,
        functionName: 'getAgentWallet',
        args: [BigInt(agentId)],
      })
      if (!eq(wallet, creator))
        throw new BoardError(
          'forbidden',
          `agent ${agentId}'s wallet is not the signed-in wallet: sign in with the agent's wallet to post as it`,
        )
      return agentId
    }
    if (this.#config.hostedCreators === undefined) return this.#noPosterAgent()
    const facts = await settleWithin(
      this.#config.hostedCreators({ addresses: [creator], allowances: [] }),
      POSTER_READ_MS,
    )
    if (facts === undefined) {
      if (this.#config.requirePosterAgent === true)
        throw new BoardError('unavailable', 'the hosted agent lookup did not answer; retry the same call')
      return null
    }
    return facts.agents.find((a) => eq(a.address, creator))?.agentId ?? this.#noPosterAgent()
  }

  /** A post from a wallet no agent resolves to: refused where the board requires poster agents, else unattributed. */
  #noPosterAgent(): null {
    if (this.#config.requirePosterAgent === true)
      throw new BoardError(
        'forbidden',
        `posting on this board needs an agent: post through your hosted agent, or register this wallet as an ERC-8004 agent and pass its agentId (${this.#config.uri}/agents/new)`,
      )
    return null
  }

  #task(taskId: string): TaskRow {
    const [row] = this.#sql.all<TaskRow>('SELECT * FROM tasks WHERE id = ?', taskId)
    if (row === undefined) throw new BoardError('not-found', `no task ${taskId}`)
    this.#taskCtx(row)
    return row
  }

  #operation(taskId: string, kind: string, actor: Address, detail?: unknown): string {
    const id = randomId()
    const now = this.#now()
    this.#sql.run(
      'INSERT INTO operations (id, task_id, kind, actor, status, tx_hash, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
      id,
      taskId,
      kind,
      actor,
      'prepared',
      detail === undefined ? null : JSON.stringify(detail),
      now,
      now,
    )
    return id
  }

  // -----------------------------------------------------------------------------------------------
  // Sign-in with Ethereum
  // -----------------------------------------------------------------------------------------------

  /** A SIWE message for `address` to sign; valid for ten minutes, once. */
  authChallenge(input: { address: string }): { message: string } {
    if (!isAddress(input.address)) throw new BoardError('invalid', 'address must be a 0x address')
    const address = getAddress(input.address)
    const nonce = randomId(12)
    const now = this.#now()
    this.#sql.run(
      'INSERT INTO siwe_nonces (nonce, address, expires_at) VALUES (?, ?, ?)',
      nonce,
      address,
      now + NONCE_SECONDS,
    )
    const message = createSiweMessage({
      address,
      chainId: this.#ctx('main').deployment.chainId,
      domain: this.#config.domain,
      uri: this.#config.uri,
      version: '1',
      nonce,
      issuedAt: new Date(now * 1000),
      expirationTime: new Date((now + NONCE_SECONDS) * 1000),
      statement: 'Sign in to the sidequest board. This signature moves no funds.',
    })
    return { message }
  }

  /** Verifies a signed challenge (EOA or ERC-1271 wallet) and opens a 24 h session. */
  async authLogin(input: {
    message: string
    signature: string
  }): Promise<{ session: string; address: Address; expiresAt: number }> {
    const fields = parseSiweMessage(input.message)
    const now = this.#now()
    if (fields.address === undefined || fields.nonce === undefined)
      throw new BoardError('invalid', 'not a SIWE message')
    if (fields.domain !== this.#config.domain) throw new BoardError('forbidden', 'SIWE domain mismatch')
    const [nonce] = this.#sql.all<{ address: string; expires_at: number; used: number }>(
      'SELECT address, expires_at, used FROM siwe_nonces WHERE nonce = ?',
      fields.nonce,
    )
    if (nonce === undefined || nonce.used !== 0 || nonce.expires_at < now || !eq(nonce.address, fields.address)) {
      throw new BoardError('forbidden', 'unknown, used or expired sign-in nonce; request a new auth_challenge')
    }
    const valid = await this.#ctx('main').publicClient.verifyMessage({
      address: fields.address,
      message: input.message,
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'signature does not match the address')
    this.#sql.run('UPDATE siwe_nonces SET used = 1 WHERE nonce = ?', fields.nonce)
    const session = randomId(32)
    const expiresAt = now + SESSION_SECONDS
    this.#sql.run('INSERT INTO sessions (id, address, expires_at) VALUES (?, ?, ?)', session, fields.address, expiresAt)
    return { session, address: fields.address, expiresAt }
  }

  /** The wallet behind a session, if it is live. */
  sessionAddress(session: string | undefined): Address | undefined {
    if (session === undefined || session === '') return undefined
    const [row] = this.#sql.all<{ address: string; expires_at: number }>(
      'SELECT address, expires_at FROM sessions WHERE id = ?',
      session,
    )
    if (row === undefined || row.expires_at < this.#now()) return undefined
    return getAddress(row.address)
  }

  /** Binds an MCP session to a signed-in board session, so an agent that signed in through a tool stays signed in. */
  bindMcpSession(mcpSession: string, session: string): void {
    this.#sql.run(
      'INSERT INTO mcp_sessions (id, session) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET session = excluded.session',
      mcpSession,
      session,
    )
  }

  /** The caller behind a bearer session or, failing that, a bound MCP session. */
  resolveCaller(auth: { bearer?: string | undefined; mcpSession?: string | undefined }): Caller {
    const direct = this.sessionAddress(auth.bearer)
    if (direct !== undefined) return { address: direct }
    if (auth.mcpSession === undefined) return {}
    const [row] = this.#sql.all<{ session: string }>('SELECT session FROM mcp_sessions WHERE id = ?', auth.mcpSession)
    const bound = this.sessionAddress(row?.session)
    return bound === undefined ? {} : { address: bound }
  }

  // -----------------------------------------------------------------------------------------------
  // Publisher
  // -----------------------------------------------------------------------------------------------

  /**
   * Freezes a new offer and hands back what the creator's wallet must send: approvals and `publish`. The offer is
   * the content-addressed manifest (`manifest` is for the caller to store at `${termsHash}.json`); nothing is
   * escrowed until the creator's `publish` confirms.
   */
  async createTask(
    caller: Caller,
    input: {
      title: string
      brief: string
      acceptanceCriteria: string[]
      tags?: readonly sdk.JobTag[]
      /** A reward token symbol from the deployment (`mUSD`, `mEUR`, `USDC`) or its address. */
      token: string
      /** Decimal amounts in the token's and SIDE's own units ("25" = 25 mEUR). */
      reward: string
      creatorBond?: string
      workerBond?: string
      /** Unix seconds. */
      deliveryDeadline: number
      approver?: string
      /** V1 per-job windows, within the deployed Holding's bounds, in seconds. */
      windows?: import('./terms.ts').EvaluatorWindows
      arbitrator?: string
      /** Shortcut to a pre-created application. The worker still signs and activates. */
      invite?: { agentId: string }
      /** The v1 main stack. */
      stack?: sdk.StackName
      /** GitHub check names evidence must cover; they become the offer's evidence policy. */
      requiredChecks?: string[]
      /**
       * Hire only (ADR-0005): the worker may spend up to `cap` (decimal, in the token's units) of `token` from the
       * creator's Privy wallet until `expiresAt` (default: the delivery deadline). Bound into the terms hash.
       */
      executionBudget?: BudgetInput
      /** The deliverable forms accepted (ADR-0006); omitted means git only. Bound into the terms hash. */
      deliverable?: DeliverableSpec
      /** Stable client key: a retry after losing the response returns this same preparation. */
      idempotencyKey?: string
      /** ADR-0019: the ERC-8004 agent posting, when the signed-in wallet is that agent's own (not needed when hosted). */
      agentId?: string
    },
    /** Set only by `pickQuote`: the offer carries the request and the picked quote. */
    quote: { requestHash: Hex; quoteHash: Hex } | null = null,
  ): Promise<TaskPreparation> {
    const creator = this.#requireCaller(caller)
    const operation = quote === null ? 'create_task' : 'pick_task'
    const saved = this.#idempotent<TaskPreparation>(creator, operation, input.idempotencyKey)
    if (saved !== undefined) {
      // A cached unsigned publication names the original Holding. Revalidate its frozen pair before returning it;
      // promotion may have retired that Holding since the cache was written. Keep the cache intact and never rebuild
      // the offer against the new main pair.
      const task = this.#task(saved.taskId)
      if (task.job_id === null) await sidequest.requireOfferHorizon(this.#taskCtx(task), parseTerms(task.terms_json))
      return saved
    }
    const tags = input.tags === undefined ? [] : normalizeTags(input.tags)
    const stack = input.stack ?? 'main'
    const ctx = this.#ctx(stack)
    await this.#requireUnpaused(stack)
    // A picked hire inherits the agent its request was admitted as.
    const posterAgent =
      quote === null
        ? await this.#posterAgent(ctx, creator, input.agentId)
        : (this.#sql.all<{ creator_agent_id: string | null }>(
            'SELECT creator_agent_id FROM quote_requests WHERE request_hash = ?',
            quote.requestHash,
          )[0]?.creator_agent_id ?? null)
    const bondPolicy = await sdk.readBondPolicy(ctx)
    const creatorBond = input.creatorBond ?? formatUnits(bondPolicy.minimumCreatorBond, 18)
    const workerBond = input.workerBond ?? '0'
    await sidequest.requireCreatorBond(ctx, parseUnits(creatorBond, 18))
    const token = await this.#resolveToken(ctx, input.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    const [windows, arbitrator, block] = await Promise.all([
      sidequest.offerWindows(ctx, input.windows, {
        deliveryDeadline: input.deliveryDeadline,
        creatorBond: parseUnits(creatorBond, 18),
        workerBond: parseUnits(workerBond, 18),
      }),
      sidequest.offerArbitrator(ctx, input.arbitrator),
      ctx.publicClient.getBlockNumber(),
    ])
    const executionBudget =
      input.executionBudget === undefined
        ? undefined
        : await this.#executionBudget(ctx, input.executionBudget, input.deliveryDeadline)
    const taskId = randomId(8)
    const terms: OfferTerms = {
      v: 2,
      deployment: {
        chainId: ctx.deployment.chainId,
        core: ctx.deployment.core,
        holding: ctx.stack.holding,
        evaluator: ctx.stack.evaluator,
        identity: ctx.deployment.identity,
      },
      taskId,
      projectId: null,
      policyVersion: null,
      mode: 'hire',
      title: input.title,
      brief: input.brief,
      acceptanceCriteria: input.acceptanceCriteria,
      ...(tags.length === 0 ? {} : { tags }),
      token,
      reward: parseUnits(input.reward, decimals),
      creatorBond: parseUnits(creatorBond, 18),
      workerBond: parseUnits(workerBond, 18),
      deliveryDeadline: input.deliveryDeadline,
      creator,
      approver: input.approver === undefined ? creator : getAddress(input.approver),
      ...(arbitrator === undefined ? {} : { arbitrator }),
      windows,
      eligibility: null,
      evidencePolicy:
        input.requiredChecks === undefined || input.requiredChecks.length === 0
          ? null
          : { checks: input.requiredChecks, trustedProducer: 'github-actions', workflowPath: '.github/workflows' },
      quote,
      ...(executionBudget === undefined ? {} : { executionBudget }),
      ...(input.deliverable === undefined ? {} : { deliverable: normalSpec(input.deliverable) }),
      salt: `0x${randomId(32)}`,
    }
    // The chain reads stay outside the catch: an RPC failure is not a refusal, and its text names the provider URL.
    const enforced = windows
    const bounds = await sdk.readWindowBounds(ctx)
    try {
      validateOffer(terms, enforced, this.#now(), ctx.stack.kind, bounds)
    } catch (e) {
      throw invalidTerms(e)
    }
    const hash = termsHash(terms)
    await sidequest.requireOfferHorizon(ctx, terms)
    const manifest = canonicalJson(terms)
    let invited: { worker: Address; agentId: string } | undefined
    if (input.invite !== undefined) {
      const agentId = input.invite.agentId
      if (typeof agentId !== 'string' || !/^[1-9]\d*$/.test(agentId) || BigInt(agentId) >= 2n ** 256n)
        throw new BoardError('invalid', 'invite.agentId must be a nonzero uint256 decimal string')
      const worker = await sdk.agentWallet(ctx, BigInt(agentId))
      if (worker === zeroAddress || [creator, terms.approver, terms.arbitrator].some((a) => eq(a, worker)))
        throw new BoardError(
          'invalid',
          'the invited agent must have a registered wallet distinct from creator, approver and arbitrator',
        )
      invited = { worker, agentId }
    }
    const symbol = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    // "mEUR"/"mUSD" read as millions to a model; say what the unit is.
    const unit =
      this.#config.network === 'monad-testnet'
        ? ` (${symbol} is a testnet mock token worth about 1 ${symbol.replace(/^m/, '')} of play money; "m" means mock, not million)`
        : ''
    const screening = await screenOffer(this.#config.screening, terms, `${input.reward} ${symbol}${unit}`, this.#now())
    const transactions = await this.#publishTransactions(ctx, creator, terms, hash as Hex)
    return this.#persist(() => {
      const prepared = this.#idempotent<TaskPreparation>(creator, operation, input.idempotencyKey)
      if (prepared !== undefined) {
        this.#task(prepared.taskId)
        return prepared
      }
      this.#sql.run(
        'INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at, screening_json, creator_agent_id) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)',
        taskId,
        creator,
        stack,
        manifest,
        hash,
        Number(block),
        this.#now(),
        JSON.stringify(screening),
        posterAgent,
      )
      this.#operation(taskId, 'publish', creator, { termsHash: hash })
      if (executionBudget !== undefined) this.#budget.promise(taskId, creator, executionBudget)

      const applicationId = invited === undefined ? undefined : randomId(8)
      if (invited !== undefined)
        this.#sql.run(
          'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          applicationId!,
          taskId,
          invited.worker,
          invited.agentId,
          'direct hire invitation',
          this.#now(),
        )

      return this.#remember(creator, operation, input.idempotencyKey, {
        taskId,
        termsHash: hash,
        screening,
        manifestUrl: `${this.#config.manifestBaseUrl}/${hash}.json`,
        manifest,
        transactions,
        ...(applicationId === undefined ? {} : { applicationId }),
        next: 'Send the transactions in order from the creator wallet, then report_transaction with the publish tx hash.',
      })
    })
  }

  /** The approvals and the `publish` of one frozen offer, exactly as agreed (terms hash = manifest hash). */
  async #publishTransactions(ctx: sdk.Ctx, creator: Address, terms: OfferTerms, hash: Hex): Promise<TxRequest[]> {
    return sidequest.publishSidequest(ctx, terms, hash)
  }

  /**
   * Creator: the publish transactions of an offer that is frozen but not on-chain (a publish that reverted, e.g. an
   * underfunded wallet after `pick_quote`, or a lost client). Safe to repeat: the contract lists a terms hash once.
   */
  async publishTransactions(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    if (!eq(task.creator, me)) throw new BoardError('forbidden', 'only the creator publishes')
    if (task.job_id !== null || (await this.#recoverPublish(task)) !== null)
      throw new BoardError('conflict', `already published as job ${task.job_id}`)
    return {
      transactions: await this.#publishTransactions(
        this.#taskCtx(task),
        me,
        parseTerms(task.terms_json),
        task.terms_hash as Hex,
      ),
    }
  }

  /** A requested budget as terms: the cap in the token's (or the native) units, the expiry defaulting to the deadline. */
  async #executionBudget(ctx: sdk.Ctx, b: BudgetInput, deliveryDeadline: number): Promise<ExecutionBudget> {
    const expiresAt = b.expiresAt ?? deliveryDeadline
    // validateOffer bounds it by now and the delivery deadline; a non-integer would compare as NaN and pass.
    if (!Number.isSafeInteger(expiresAt))
      throw new BoardError('invalid', 'executionBudget.expiresAt must be unix seconds')
    if (b.kind === 'call') {
      if (b.target === undefined || !isAddress(b.target))
        throw new BoardError('invalid', 'a call budget needs the contract address (`target`)')
      if (b.function === undefined)
        throw new BoardError(
          'invalid',
          'a call budget needs the allowed `function`, e.g. "function create((string,string) params) payable"',
        )
      let cap: bigint
      try {
        cap = parseUnits(b.cap, 18)
      } catch {
        throw new BoardError('invalid', 'the call budget cap must be a decimal amount of the native token')
      }
      const call: CallBudget = {
        kind: 'call',
        target: getAddress(b.target),
        function: b.function.trim(),
        cap,
        expiresAt,
      }
      try {
        callFunction(call)
      } catch {
        throw new BoardError('invalid', '`function` must be one function in human-readable ABI form')
      }
      return call
    }
    if (b.kind !== 'advance') throw new BoardError('invalid', "an execution budget is an 'advance' or a 'call'")
    if (b.token === undefined) throw new BoardError('invalid', 'an advance needs its `token`')
    const token = await this.#advanceToken(ctx, b.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    let cap: bigint
    try {
      cap = parseUnits(b.cap, decimals)
    } catch {
      throw new BoardError('invalid', 'the advance cap must be a decimal number')
    }
    return { kind: 'advance', token, cap, expiresAt }
  }

  /** Any ERC-20 by address (it must answer `decimals`), or a reward token by symbol. */
  async #advanceToken(ctx: sdk.Ctx, token: string): Promise<Address> {
    if (!isAddress(token)) return this.#resolveToken(ctx, token)
    const t = getAddress(token)
    await ctx.publicClient.readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }).catch(() => {
      throw new BoardError('invalid', `${t} is not an ERC-20 on ${ctx.deployment.network}`)
    })
    return t
  }

  /** A base-unit amount as people read it: the token's symbol and a decimal amount. */
  async #displayAmount<T extends { token: Address; amount: string }>(
    ctx: sdk.Ctx,
    x: T,
  ): Promise<T & { symbol: string }> {
    const [symbol, decimals] = await Promise.all([
      ctx.publicClient.readContract({ address: x.token, abi: erc20Abi, functionName: 'symbol' }),
      ctx.publicClient.readContract({ address: x.token, abi: erc20Abi, functionName: 'decimals' }),
    ])
    return { ...x, symbol, amount: formatUnits(BigInt(x.amount), decimals) }
  }

  /**
   * A reward token by symbol (one of the known tokens) or by address: any ERC-20 that answers `symbol` and `decimals`
   * (ADR-0010). A token the deployment does not list needs a stack whose Holding is safe with any ERC-20.
   */
  async #resolveToken(ctx: sdk.Ctx, token: string): Promise<Address> {
    if (!isAddress(token)) {
      for (const t of ctx.deployment.rewardTokens) {
        const symbol = await ctx.publicClient.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' })
        if (symbol.toLowerCase() === token.toLowerCase()) return t
      }
      throw new BoardError(
        'invalid',
        `"${token}" is not a known token symbol; name the token by its address (any ERC-20)`,
      )
    }
    const t = getAddress(token)
    if (ctx.deployment.rewardTokens.some((r) => eq(r, t))) return t
    const symbol = await Promise.all([
      ctx.publicClient.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }),
      ctx.publicClient.readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }),
    ]).then(
      ([sym]) => sym,
      () => {
        throw new BoardError(
          'invalid',
          `${t} is not an ERC-20 on ${ctx.deployment.network}: it must answer symbol() and decimals()`,
        )
      },
    )
    if (!ctx.stack.openTokens) {
      const open = Object.entries(ctx.deployment.stacks)
        .filter(([, st]) => st?.openTokens)
        .map(([name]) => name)
      throw new BoardError(
        'invalid',
        `${symbol} (${t}) is not a known token, and this stack's Holding predates open tokens (ADR-0010): publish it on ${open.length === 0 ? 'a redeployed stack' : `the ${open.join(' or ')} stack`}`,
      )
    }
    return t
  }

  /** Reconcile the original vault operation; omitting txHash polls a previously reported hash. Never prepares or sends. */
  async reportOperation(caller: Caller, input: { operationId: string; txHash?: string }) {
    const me = this.#requireCaller(caller)
    const [op] = this.#sql.all<OperationRow>(
      'SELECT * FROM operations WHERE id=? AND lower(actor)=lower(?)',
      input.operationId,
      me,
    )
    if (op === undefined) throw new BoardError('not-found', 'no wallet operation for this caller')
    if (!['stake', 'request-unstake', 'cancel-unstake', 'withdraw-stake'].includes(op.kind))
      throw new BoardError('invalid', 'this operation belongs to a task; use report_transaction')
    if (input.txHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(input.txHash))
      throw new BoardError('invalid', 'txHash must be a transaction hash')
    if (op.status === 'prepared') {
      const hash = input.txHash ?? op.tx_hash
      if (hash !== null) {
        // Keep the reported hash through a lost response. It is a claim until its exact vault event confirms it.
        this.#sql.run(
          "UPDATE operations SET tx_hash=?,updated_at=? WHERE id=? AND status='prepared'",
          hash,
          this.#now(),
          op.id,
        )
        const ctx = this.#ctx('main')
        const receipt = await ctx.publicClient.getTransactionReceipt({ hash: hash as Hex }).catch(() => undefined)
        if (receipt === undefined)
          throw new BoardError('chain', 'no receipt yet for the reported wallet operation; retry shortly')
        if (receipt.status === 'success') {
          const timestamp = await receiptTimestamp(ctx, receipt, hash)
          if (timestamp < op.created_at)
            throw new BoardError(
              'chain',
              'the reported receipt predates this operation; reconcile the original operation',
            )
          const event = vaultOperationEvent(
            ctx,
            receipt,
            op,
            consumedOperationEvents(this.#sql, ctx.deployment.chainId, receipt),
          )
          if (event !== null)
            confirmOperationEvent(this.#sql, {
              chainId: ctx.deployment.chainId,
              hash,
              logIndex: event.logIndex,
              op,
              now: this.#now(),
              result: event.result,
            })
        }
      }
    }
    const [saved] = this.#sql.all<OperationRow>('SELECT * FROM operations WHERE id=?', op.id)
    return {
      operationId: op.id,
      kind: op.kind,
      status: saved!.status,
      txHash: saved!.tx_hash,
      result: saved!.detail === null ? null : (JSON.parse(saved!.detail).result ?? null),
    }
  }

  /**
   * Reconciles a task from the chain after the caller sent a transaction: a publish is recorded only once its
   * receipt shows a `Published` event for this creator and this offer's `termsHash`. Any other transaction only triggers a
   * fresh read; nothing is taken from the caller's word.
   */
  async reportTransaction(caller: Caller, input: { taskId: string; txHash: string }) {
    const task = this.#task(input.taskId)
    const ctx = this.#taskCtx(task)
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: input.txHash as Hex }).catch(() => undefined)
    if (receipt === undefined) throw new BoardError('chain', `no receipt yet for ${input.txHash}; retry shortly`)
    if (task.job_id !== null) {
      const prepared = this.#sql.all<OperationRow>(
        "SELECT * FROM operations WHERE task_id=? AND status='prepared'",
        task.id,
      )
      if (receipt.status === 'success' && prepared.length > 0) {
        const timestamp = await receiptTimestamp(ctx, receipt, input.txHash)
        const eligible = prepared.filter((op) => op.created_at <= timestamp)
        const consumed = consumedOperationEvents(this.#sql, ctx.deployment.chainId, receipt)
        for (const event of await confirmedOperationEvents(ctx, BigInt(task.job_id), receipt, eligible, consumed)) {
          const op = eligible.find((row) => row.id === event.operationId)!
          confirmOperationEvent(this.#sql, {
            chainId: ctx.deployment.chainId,
            hash: input.txHash,
            logIndex: event.logIndex,
            op,
            now: this.#now(),
          })
        }
      }
    }
    // The core's JobSubmitted is the one deliverable that counts; record it for the evidence labels.
    for (const log of receipt.logs) {
      if (!eq(log.address, ctx.deployment.core)) continue
      try {
        const event = decodeEventLog({ abi: sdk.coreAbi, data: log.data, topics: log.topics })
        if (event.eventName === 'JobSubmitted' && task.job_id !== null && event.args.jobId === BigInt(task.job_id)) {
          this.#sql.run(
            'INSERT OR REPLACE INTO onchain_submissions (task_id, deliverable_hash, tx_hash) VALUES (?, ?, ?)',
            task.id,
            event.args.deliverable,
            input.txHash,
          )
        }
      } catch {
        // another event
      }
    }
    if (task.job_id === null && receipt.status === 'success') {
      for (const log of receipt.logs) {
        if (!eq(log.address, ctx.stack.holding)) continue
        try {
          const event = decodeEventLog({ abi: sidequest.holdingAbi(ctx), data: log.data, topics: log.topics })
          if (
            event.eventName === 'Published' &&
            eq(event.args.policyHash, task.terms_hash) &&
            eq(event.args.creator, task.creator)
          ) {
            const bound = this.#sql.all<{ id: string }>(
              'UPDATE tasks SET job_id = ?, publish_tx = ? WHERE id = ? AND job_id IS NULL RETURNING id',
              event.args.jobId.toString(),
              input.txHash,
              task.id,
            )
            if (bound.length === 0) break
            this.#sql.run(
              "UPDATE operations SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE task_id = ? AND kind = 'publish'",
              input.txHash,
              this.#now(),
              task.id,
            )
            break
          }
        } catch {
          // another event
        }
      }
    }
    // A redemption of this task's execution-budget delegation (to the manager, or inside the worker's own batch).
    await this.#budget.observe({ task, terms: parseTerms(task.terms_json), ctx }, receipt)
    return this.getTask(caller, { taskId: input.taskId })
  }

  listApplications(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator sees applications')
    return this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE task_id = ? ORDER BY created_at', task.id)
  }

  /** The Selection the creator signs to pick one applicant. Nothing is on-chain until the worker activates. */
  async selectWorker(caller: Caller, input: { taskId: string; applicationId: string; activateBy?: number }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator selects')
    const terms = parseTerms(task.terms_json)
    if (task.job_id === null) throw new BoardError('conflict', 'publish the offer first')
    const [app] = this.#sql.all<ApplicationRow>(
      'SELECT * FROM applications WHERE id = ? AND task_id = ?',
      input.applicationId,
      task.id,
    )
    if (app === undefined) throw new BoardError('not-found', 'no such application')
    const activateBy = input.activateBy ?? Math.min(this.#now() + 24 * 3600, terms.deliveryDeadline - 60)
    if (activateBy >= terms.deliveryDeadline)
      throw new BoardError('invalid', 'activateBy must precede the delivery deadline')
    const ctx = this.#taskCtx(task)
    const nonce = randomUint(16)
    const listing = await sdk.getV1Listing(ctx, BigInt(task.job_id))
    await sidequest.requireBondHorizon(ctx, listing.expiredAt, 0n, listing.workerBond)
    this.#sql.run(
      'INSERT INTO selections (task_id, nonce, application_id, worker, agent_id, activate_by, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      task.id,
      nonce.toString(),
      app.id,
      app.worker,
      app.agent_id,
      activateBy,
      this.#now(),
    )
    const selection: sdk.Selection = {
      jobId: BigInt(task.job_id),
      worker: getAddress(app.worker),
      agentId: BigInt(app.agent_id),
      termsHash: task.terms_hash as Hex,
      activateBy,
      nonce,
    }
    return {
      nonce: nonce.toString(),
      sign: {
        description: 'Selection: sign with the creator wallet, then submit_selection with the signature',
        typedData: typedDataJson(
          sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
          sdk.selectionTypes,
          'Selection',
          selection,
        ),
      } satisfies SignRequest,
    }
  }

  /** Stores the creator's signed Selection after checking it recovers to the creator. */
  async verifyAgentSigning(
    caller: Caller,
    input: { tool: string; args: Record<string, unknown>; typedData: string },
  ): Promise<string> {
    const me = this.#requireCaller(caller)
    if (typeof input.args.taskId !== 'string') throw new BoardError('invalid', 'signing requires a task')
    const task = this.#task(input.args.taskId)
    const ctx = this.#taskCtx(task)
    const typed = assertAgentEnvelope(ctx, input.typedData, me)
    await this.#requireUnpaused(task)
    const view = await this.#requireListingMatches(task)
    if (view.status !== 'open' || view.provider !== null)
      throw new BoardError('conflict', 'signing requires an open unassigned hire')
    const terms = parseTerms(task.terms_json)
    let expected: string
    if (input.tool === 'select_worker' && typed.primaryType === 'Selection') {
      if (!eq(task.creator, me)) throw new BoardError('forbidden', 'only the agent creator signs its selection')
      const sel = this.#sql.all<SelectionRow>(
        'SELECT * FROM selections WHERE task_id=? AND nonce=?',
        task.id,
        String(typed.message.nonce),
      )[0]
      const app = this.#sql.all<ApplicationRow>(
        'SELECT * FROM applications WHERE task_id=? AND id=?',
        task.id,
        String(input.args.applicationId),
      )[0]
      if (
        sel === undefined ||
        app === undefined ||
        sel.application_id !== app.id ||
        !eq(sel.worker, app.worker) ||
        sel.agent_id !== app.agent_id ||
        sel.activate_by < this.#now() ||
        sel.activate_by >= terms.deliveryDeadline
      )
        throw new BoardError('forbidden', 'selection differs from its frozen application or deadline')
      const [wallet, used] = await Promise.all([
        sdk.agentWallet(ctx, BigInt(sel.agent_id)),
        ctx.publicClient.readContract({
          address: ctx.stack.holding,
          abi: sdk.sidequestHoldingAbi,
          functionName: 'selectionNonceUsed',
          args: [me, BigInt(sel.nonce)],
        }),
      ])
      if (!eq(wallet, sel.worker) || used)
        throw new BoardError('forbidden', 'selection wallet changed or nonce was used')
      expected = typedDataJson(
        sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
        sdk.selectionTypes,
        'Selection',
        this.#selection(task, sel),
      )
    } else if (input.tool === 'prepare_activation' && typed.primaryType === 'SetBudgetAuthorization') {
      const sel = this.#liveSelectionFor(task, me)
      const prep = this.#sql.all<{ nonce: string; budget_nonce: string; budget_deadline: number }>(
        'SELECT * FROM activation_preps WHERE task_id=? AND worker=?',
        task.id,
        me,
      )[0]
      if (prep === undefined || prep.nonce !== sel.nonce || prep.budget_deadline <= this.#now())
        throw new BoardError('conflict', 'activation preparation expired or changed')
      const [wallet, valid, used] = await Promise.all([
        sdk.agentWallet(ctx, BigInt(sel.agent_id)),
        ctx.publicClient.verifyTypedData({
          address: getAddress(task.creator),
          domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
          types: sdk.selectionTypes,
          primaryType: 'Selection',
          message: { ...this.#selection(task, sel) },
          signature: sel.signature as Hex,
        }),
        ctx.publicClient.readContract({
          address: ctx.stack.holding,
          abi: sdk.sidequestHoldingAbi,
          functionName: 'selectionNonceUsed',
          args: [getAddress(task.creator), BigInt(sel.nonce)],
        }),
      ])
      if (!eq(wallet, me) || !valid || used)
        throw new BoardError('forbidden', 'worker registration or creator selection is no longer valid')
      const quote = await sidequest.activationQuote(ctx, this.#jobId(task), me, terms)
      expected = typedDataJson(
        sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core),
        sdk.setBudgetTypes,
        'SetBudgetAuthorization',
        {
          signer: me,
          jobId: this.#jobId(task),
          token: terms.token,
          amount: quote.net,
          optParamsHash: sdk.EMPTY_HASH,
          nonce: BigInt(prep.budget_nonce),
          deadline: BigInt(prep.budget_deadline),
        },
      )
    } else {
      throw new BoardError('forbidden', 'this tool has no routine signing scope')
    }
    assertExactAgentTypedData(input.typedData, expected)
    return expected
  }

  async submitSelection(caller: Caller, input: { taskId: string; nonce: string; signature: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator selects')
    const [sel] = this.#sql.all<SelectionRow>(
      'SELECT * FROM selections WHERE task_id = ? AND nonce = ?',
      task.id,
      input.nonce,
    )
    if (sel === undefined) throw new BoardError('not-found', 'no such pending selection')
    const ctx = this.#taskCtx(task)
    const valid = await ctx.publicClient.verifyTypedData({
      address: getAddress(task.creator),
      domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
      types: sdk.selectionTypes,
      primaryType: 'Selection',
      message: { ...this.#selection(task, sel) },
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'the signature is not the creator’s over this selection')
    this.#sql.run(
      'UPDATE selections SET signature = ? WHERE task_id = ? AND nonce = ?',
      input.signature,
      task.id,
      input.nonce,
    )
    return { ok: true, worker: sel.worker, activateBy: sel.activate_by }
  }

  #selection(task: TaskRow, sel: SelectionRow): sdk.Selection {
    return {
      jobId: BigInt(task.job_id ?? '0'),
      worker: getAddress(sel.worker),
      agentId: BigInt(sel.agent_id),
      termsHash: task.terms_hash as Hex,
      activateBy: sel.activate_by,
      nonce: BigInt(sel.nonce),
    }
  }

  /**
   * Creator: withdraw an open hire nobody has activated. Holding's `cancel` ends it on-chain; `settle` in the same
   * call returns the reward and applies the listing's ten-minute grace-period bond-forfeit rule.
   */
  async cancelTask(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator cancels')
    const view = await this.#chainView(task)
    if (view.status !== 'open' && view.status !== 'lapsed')
      throw new BoardError('conflict', 'only an open hire nobody activated can be cancelled')
    const ctx = this.#taskCtx(task)
    this.#operation(task.id, 'cancel', me)
    return {
      transactions: [
        this.#tx(
          ctx,
          'Cancel the unactivated hire and refund its reward',
          ctx.stack.holding,
          encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancel', args: [this.#jobId(task)] }),
          sdk.V1_GAS.cancel,
        ),
      ],
    }
  }

  /** Whether the caller is the creator. */
  #actsForCreator(task: TaskRow, me: Address): boolean {
    return eq(task.creator, me)
  }

  async approveWork(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver accepts')
    const ctx = this.#taskCtx(task)
    this.#operation(task.id, 'accept', me)
    return {
      transactions: [
        this.#tx(
          ctx,
          'accept: pays the reward from escrow, returns both bonds',
          ctx.stack.evaluator,
          encodeFunctionData({ abi: sidequest.evaluatorAbi(ctx), functionName: 'accept', args: [this.#jobId(task)] }),
          sdk.V1_GAS.evaluator,
        ),
      ],
    }
  }

  async rejectWork(caller: Caller, input: { taskId: string; violation: sdk.ViolationName; reason: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver rejects')
    if (!(input.violation in sdk.Violation)) throw new BoardError('invalid', 'violation is None, Quality or Falsified')
    const reasonHash = sdk.hashText(input.reason)
    this.#sql.run(
      'INSERT OR IGNORE INTO reasons (hash, task_id, text, created_at) VALUES (?, ?, ?, ?)',
      reasonHash,
      task.id,
      input.reason,
      this.#now(),
    )
    const ctx = this.#taskCtx(task)
    this.#operation(task.id, 'reject', me, { violation: input.violation, reasonHash })
    return {
      reasonHash,
      transactions: [
        this.#tx(
          ctx,
          `reject (${input.violation}): nothing moves; the worker may dispute`,
          ctx.stack.evaluator,
          encodeFunctionData({
            abi: sidequest.evaluatorAbi(ctx),
            functionName: 'reject',
            args: [this.#jobId(task), sdk.Violation[input.violation], reasonHash],
          }),
        ),
      ],
    }
  }

  #jobId(task: TaskRow): bigint {
    if (task.job_id === null) throw new BoardError('conflict', 'the offer is not published yet')
    return BigInt(task.job_id)
  }

  // -----------------------------------------------------------------------------------------------
  // Quotes (quote-to-hire, ADR-0004)
  // -----------------------------------------------------------------------------------------------

  /**
   * A quote request: "Accepting quotes — reward not escrowed". It names the work, the accepted reward tokens, both
   * bonds and the deadlines; bidders answer with one token and an exact amount. Nothing moves until a pick.
   */
  async requestQuotes(
    caller: Caller,
    input: {
      title: string
      brief: string
      acceptanceCriteria: string[]
      tags?: readonly sdk.JobTag[]
      tokens: string[]
      creatorBond?: string
      workerBond?: string
      deliveryDeadline: number
      quoteDeadline: number
      stack?: sdk.StackName
      approver?: string
      requiredChecks?: string[]
      windows?: import('./terms.ts').EvaluatorWindows
      arbitrator?: string
      /** The deliverable forms accepted (ADR-0006); the picked hire inherits them. */
      deliverable?: DeliverableSpec
      /** A public maximum price in one token; the request then accepts only that token and refuses quotes above it. */
      budget?: { token: string; max: string }
      /** Optional public invite to one agent; the request remains open to every bidder. */
      invite?: { agentId: string }
      idempotencyKey?: string
      /** ADR-0019: the ERC-8004 agent posting, when the signed-in wallet is that agent's own (not needed when hosted). */
      agentId?: string
    },
  ) {
    const creator = this.#requireCaller(caller)
    const saved = this.#idempotent<QuotePreparation>(creator, 'request_quotes', input.idempotencyKey)
    if (saved !== undefined) return this.#withRequestDeadlines(saved)
    const tags = input.tags === undefined ? [] : normalizeTags(input.tags)
    const stack = input.stack ?? 'main'
    const ctx = this.#ctx(stack)
    const posterAgent = await this.#posterAgent(ctx, creator, input.agentId)
    const bondPolicy = await sdk.readBondPolicy(ctx)
    const creatorBond = input.creatorBond ?? formatUnits(bondPolicy.minimumCreatorBond, 18)
    const workerBond = input.workerBond ?? '0'
    await sidequest.requireCreatorBond(ctx, parseUnits(creatorBond, 18))
    const budget = input.budget === undefined ? undefined : await this.#requestBudget(ctx, input.budget)
    if (budget !== undefined && input.tokens.length > 0) {
      const named = await Promise.all(input.tokens.map((t) => this.#resolveToken(ctx, t)))
      if (named.length !== 1 || !eq(named[0]!, budget.token)) {
        throw new BoardError(
          'invalid',
          'a request with a budget accepts only its budget token: omit tokens or pass [budget.token]',
        )
      }
    }
    if (budget === undefined && input.tokens.length === 0)
      throw new BoardError('invalid', 'name at least one accepted token')
    const tokens =
      budget !== undefined ? [budget.token] : await Promise.all(input.tokens.map((t) => this.#resolveToken(ctx, t)))
    const now = this.#now()
    if (input.quoteDeadline <= now || input.quoteDeadline >= input.deliveryDeadline) {
      throw new BoardError('invalid', 'the quote deadline must be in the future and before the delivery deadline')
    }
    const request = {
      v: 1,
      chainId: ctx.deployment.chainId,
      stack,
      creator,
      approver: input.approver === undefined ? creator : getAddress(input.approver),
      title: input.title,
      brief: input.brief,
      acceptanceCriteria: input.acceptanceCriteria,
      ...(tags.length === 0 ? {} : { tags }),
      tokens,
      ...(budget === undefined ? {} : { budget: { token: budget.token, max: budget.max.toString() } }),
      creatorBond,
      workerBond,
      deliveryDeadline: input.deliveryDeadline,
      quoteDeadline: input.quoteDeadline,
      requiredChecks: input.requiredChecks ?? [],
      windows: await sidequest.offerWindows(ctx, input.windows, {
        deliveryDeadline: input.deliveryDeadline,
        creatorBond: parseUnits(creatorBond, 18),
        workerBond: parseUnits(workerBond, 18),
      }),
      arbitrator: await sidequest.offerArbitrator(ctx, input.arbitrator),
      ...(input.deliverable === undefined ? {} : { deliverable: normalSpec(input.deliverable) }),
      salt: `0x${randomId(32)}`,
    }
    {
      const bounds = await sdk.readWindowBounds(ctx)
      try {
        validateOffer(
          {
            mode: 'hire',
            windows: request.windows!,
            arbitrator: request.arbitrator!,
            creator,
            approver: request.approver,
            reward: 1n,
            creatorBond: parseUnits(creatorBond, 18),
            workerBond: parseUnits(workerBond, 18),
            deliveryDeadline: input.deliveryDeadline,
          } as OfferTerms,
          request.windows!,
          now,
          'sidequest-v1',
          bounds,
        )
      } catch (e) {
        throw invalidTerms(e)
      }
    }
    await sidequest.requireOfferHorizon(ctx, {
      deliveryDeadline: request.deliveryDeadline,
      windows: request.windows,
      creatorBond: parseUnits(creatorBond, 18),
      workerBond: parseUnits(workerBond, 18),
    })
    let invited: { worker: Address; agentId: string } | undefined
    if (input.invite !== undefined) {
      if (!isQuoteInvite(input.invite))
        throw new BoardError('invalid', 'invite.agentId must be a nonzero uint256 decimal string')
      const agentId = input.invite.agentId
      const worker = await sdk.agentWallet(ctx, BigInt(agentId))
      if (worker === zeroAddress || [creator, request.approver, request.arbitrator].some((a) => eq(a, worker)))
        throw new BoardError(
          'invalid',
          'the invited agent must have a registered wallet distinct from creator, approver and arbitrator',
        )
      invited = { worker, agentId }
    }
    const requestJson = canonicalJson(request)
    const requestHash = sdk.hashText(requestJson)
    const id = randomId(8)
    return this.#persist(() => {
      const prior = this.#idempotent<QuotePreparation>(creator, 'request_quotes', input.idempotencyKey)
      if (prior !== undefined) return this.#withRequestDeadlines(prior)
      this.#sql.run(
        'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at, creator_agent_id, invited_agent, invited_wallet) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
        id,
        creator,
        stack,
        requestJson,
        requestHash,
        input.quoteDeadline,
        now,
        posterAgent,
        invited?.agentId ?? null,
        invited?.worker ?? null,
      )
      return this.#withRequestDeadlines(
        this.#remember(creator, 'request_quotes', input.idempotencyKey, {
          requestId: id,
          requestHash,
          status: 'Accepting quotes — reward not escrowed',
          next: 'Wait for quotes; list_quotes, then pick_quote.',
        }),
      )
    })
  }

  /** The deadlines the stored request froze, so a retry reports what was agreed, not what its arguments resolve to now. */
  #withRequestDeadlines(
    prepared: QuotePreparation,
  ): QuotePreparation & { deliveryDeadline: number; quoteDeadline: number; invite: QuoteRequestRead['invite'] } {
    const row = this.#quoteRequest(prepared.requestId)
    const request = JSON.parse(row.request_json) as {
      deliveryDeadline: number
      quoteDeadline: number
    }
    return {
      ...prepared,
      deliveryDeadline: request.deliveryDeadline,
      quoteDeadline: request.quoteDeadline,
      invite: this.#requestInvite(row),
    }
  }

  #requestInvite(row: QuoteRequestRow): QuoteRequestRead['invite'] {
    return row.invited_agent == null || row.invited_wallet == null
      ? null
      : { agentId: row.invited_agent, wallet: row.invited_wallet }
  }

  /** A request's budget as named: a token this stack can pay in and a positive maximum in its units. */
  async #requestBudget(ctx: sdk.Ctx, input: { token: string; max: string }): Promise<{ token: Address; max: bigint }> {
    if (
      typeof input !== 'object' ||
      input === null ||
      typeof input.token !== 'string' ||
      typeof input.max !== 'string'
    ) {
      throw new BoardError('invalid', 'budget is {token, max}')
    }
    const token = await this.#resolveToken(ctx, input.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    let max: bigint
    try {
      max = parseUnits(input.max, decimals)
    } catch {
      throw new BoardError('invalid', 'budget.max must be a decimal number')
    }
    if (max <= 0n) throw new BoardError('invalid', 'budget.max must be positive')
    return { token, max }
  }

  #quoteRequest(requestId: string): QuoteRequestRow {
    const [row] = this.#sql.all<QuoteRequestRow>('SELECT * FROM quote_requests WHERE id = ?', requestId)
    if (row === undefined) throw new BoardError('not-found', `no quote request ${requestId}`)
    return row
  }

  /**
   * Public discovery lists open requests; `recent` adds the ones that closed or were picked within the last week (for
   * Explore's single list). A connected creator may page every request it created, including picked/expired rows.
   * Every row carries its board record time and how many bidders quoted; the amounts and the bidders stay private.
   */
  listQuoteRequests(caller: Caller): Promise<QuoteRequestRead[]>
  listQuoteRequests(
    caller: Caller,
    input: { mine: true; cursor?: string },
  ): Promise<{ requests: QuoteRequestRead[]; nextCursor?: string }>
  listQuoteRequests(caller: Caller, input: { mine?: false; recent?: boolean }): Promise<QuoteRequestRead[]>
  listQuoteRequests(
    caller: Caller,
    input: { mine?: boolean; cursor?: string; recent?: boolean },
  ): Promise<QuoteRequestRead[] | { requests: QuoteRequestRead[]; nextCursor?: string }>
  async listQuoteRequests(
    caller: Caller,
    input: { mine?: boolean; cursor?: string; recent?: boolean } = {},
  ): Promise<QuoteRequestRead[] | { requests: QuoteRequestRead[]; nextCursor?: string }> {
    const now = this.#now()
    if (input.mine !== true) {
      if (input.cursor !== undefined) throw new BoardError('invalid', 'cursor requires mine=true')
      const open = this.#sql.all<QuoteRequestRow>(
        'SELECT * FROM quote_requests WHERE task_id IS NULL AND quote_deadline > ? ORDER BY created_at DESC LIMIT 50',
        now,
      )
      const recent =
        input.recent !== true
          ? []
          : this.#sql.all<QuoteRequestRow>(
              'SELECT * FROM quote_requests WHERE (task_id IS NOT NULL OR quote_deadline <= ?) AND quote_deadline > ? ORDER BY quote_deadline DESC LIMIT 50',
              now,
              now - RECENT_REQUESTS,
            )
      return this.#withPosterFacts(this.#requestReads([...open, ...recent], now), now)
    }
    if (input.recent === true)
      throw new BoardError('invalid', 'recent applies to the public list; omit it with mine=true')
    const me = this.#requireCaller(caller)
    const cursor =
      input.cursor === undefined
        ? undefined
        : (() => {
            const match = /^qr:(\d+):(.+)$/.exec(input.cursor!)
            if (match === null)
              throw new BoardError('invalid', 'cursor must be a value returned by list_quote_requests')
            return { createdAt: Number(match[1]), id: match[2]! }
          })()
    const rows = this.#sql.all<QuoteRequestRow>(
      `SELECT * FROM quote_requests WHERE creator = ?${cursor === undefined ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))'} ORDER BY created_at DESC, id DESC LIMIT 51`,
      me,
      ...(cursor === undefined ? [] : [cursor.createdAt, cursor.createdAt, cursor.id]),
    )
    const page = rows.slice(0, 50)
    const requests = this.#requestReads(page, now)
    const last = page.at(-1)
    return {
      requests,
      ...(rows.length > page.length && last !== undefined ? { nextCursor: `qr:${last.created_at}:${last.id}` } : {}),
    }
  }

  /** Request rows as read: the frozen request, then the board's own facts, which a stored key can never override. */
  #requestReads(rows: readonly QuoteRequestRow[], now: number): QuoteRequestRead[] {
    const counts = new Map<string, number>()
    // Bound parameters stay under Cloudflare's 100 per statement.
    for (let i = 0; i < rows.length; i += 90) {
      const ids = rows.slice(i, i + 90).map((r) => r.id)
      if (ids.length === 0) continue
      for (const c of this.#sql.all<{ request_id: string; n: number }>(
        `SELECT request_id, COUNT(*) AS n FROM quotes WHERE request_id IN (${ids.map(() => '?').join(', ')}) GROUP BY request_id`,
        ...ids,
      )) {
        counts.set(c.request_id, Number(c.n))
      }
    }
    return rows.map((r) => ({
      ...(JSON.parse(r.request_json) as object),
      requestId: r.id,
      requestHash: r.request_hash,
      taskId: r.task_id,
      status:
        r.task_id !== null
          ? 'Picked — hire linked'
          : now >= r.quote_deadline
            ? 'Expired — reward not escrowed'
            : 'Accepting quotes — reward not escrowed',
      createdAt: r.created_at,
      // One quote per bidder (UNIQUE request_id, worker), so this counts bidders.
      quotesCount: counts.get(r.id) ?? 0,
      ...(r.creator_agent_id == null ? {} : { creatorAgentId: r.creator_agent_id }),
      invite: this.#requestInvite(r),
    }))
  }

  /**
   * Public facts about each poster: the hosted agent behind its wallet, and on open budgeted requests whether what can
   * fund the pick covers the budget. A hosted agent's pick is paid from one weekly-budget grant (stack main only),
   * anyone else's from their wallet. Nothing is locked; a read that fails says null, never a guess.
   */
  async #withPosterFacts(reads: QuoteRequestRead[], now: number): Promise<QuoteRequestRead[]> {
    type Budgeted = {
      read: QuoteRequestRead
      key: string
      stack: string
      creator: Address
      token: Address
      max: bigint
    }
    const fresh = <T extends { at: number }>(hit: T | undefined, ttl: number) =>
      hit !== undefined && now - hit.at < ttl ? hit : undefined
    const creatorOf = (r: QuoteRequestRead) =>
      typeof r.creator === 'string' && isAddress(r.creator) ? getAddress(r.creator) : undefined
    const budgeted: Budgeted[] = reads.flatMap((read) => {
      const budget = read.budget as { token: Address; max: string } | undefined
      const creator = creatorOf(read)
      if (
        budget === undefined ||
        creator === undefined ||
        read.taskId !== null ||
        now >= (read.quoteDeadline as number)
      )
        return []
      const stack = read.stack as string,
        token = getAddress(budget.token)
      return [
        {
          read,
          key: `${stack}:${creator.toLowerCase()}:${token.toLowerCase()}`,
          stack,
          creator,
          token,
          max: BigInt(budget.max),
        },
      ]
    })
    const pending = budgeted.filter((b) => fresh(this.#coverCache.get(b.key), 30) === undefined)
    const unknown = [...new Set(reads.flatMap((r) => creatorOf(r) ?? []))].filter(
      (c) => fresh(this.#creatorCache.get(c.toLowerCase()), 300) === undefined,
    )
    let facts: HostedCreatorFacts | undefined = { agents: [], allowances: [] }
    const ask = {
      addresses: unknown,
      allowances: pending.filter((b) => b.stack === 'main').map((b) => ({ address: b.creator, token: b.token })),
    }
    if (this.#config.hostedCreators !== undefined && (ask.addresses.length > 0 || ask.allowances.length > 0)) {
      facts = await settleWithin(this.#config.hostedCreators(ask), POSTER_READ_MS)
    }
    if (facts !== undefined) {
      const wallets = new Set([...ask.addresses, ...ask.allowances.map((a) => a.address)].map((a) => a.toLowerCase()))
      for (const wallet of wallets)
        this.#creatorCache.set(wallet, {
          at: now,
          agentId: facts.agents.find((a) => eq(a.address, wallet as Address))?.agentId ?? null,
        })
    }
    const agentOf = (creator: Address) => fresh(this.#creatorCache.get(creator.toLowerCase()), 300)?.agentId
    // Hosted posters on main: one grant's headroom. Everyone else, or a hosted poster elsewhere: the wallet balance.
    const balances = pending.filter(
      (b) => !(b.stack === 'main' && agentOf(b.creator) != null) && agentOf(b.creator) !== undefined,
    )
    for (const b of pending) {
      if (b.stack !== 'main' || agentOf(b.creator) == null) continue
      const grant = facts?.allowances.find((a) => eq(a.address, b.creator) && eq(a.token, b.token))
      if (facts !== undefined)
        this.#coverCache.set(b.key, { at: now, funds: grant === undefined ? 0n : BigInt(grant.available) })
    }
    for (const stack of new Set(balances.map((b) => b.stack))) {
      const group = balances.filter((b) => b.stack === stack)
      const ctx = this.#config.contexts[stack as sdk.StackName]
      if (ctx === undefined) continue
      const results =
        (await settleWithin(
          ctx.publicClient.multicall({
            contracts: group.map(
              (b) => ({ address: b.token, abi: erc20Abi, functionName: 'balanceOf', args: [b.creator] }) as const,
            ),
            allowFailure: true,
          }),
          POSTER_READ_MS,
        )) ?? []
      group.forEach((b, i) => {
        const result = results[i]
        if (result?.status === 'success') this.#coverCache.set(b.key, { at: now, funds: result.result as bigint })
      })
    }
    return reads.map((read) => {
      const creator = creatorOf(read)
      const agentId = creator === undefined ? undefined : agentOf(creator)
      const b = budgeted.find((x) => x.read === read)
      const cover = b === undefined ? undefined : fresh(this.#coverCache.get(b.key), 30)
      return {
        ...read,
        creatorAgentId: read.creatorAgentId ?? agentId ?? null,
        ...(b === undefined ? {} : { budgetCovered: cover === undefined ? null : cover.funds >= b.max }),
      }
    })
  }

  /** A bidder's quote: one accepted token and an exact amount. A later quote from the same bidder replaces it. */
  async submitQuote(
    caller: Caller,
    input: {
      requestId: string
      agentId: string
      token: string
      amount: string
      note?: string
      /** Optional (ADR-0005): what the work is expected to cost to run, in any ERC-20; not part of the price. */
      expectedCosts?: { token: string; amount: string; note?: string }
    },
  ) {
    const me = this.#requireCaller(caller)
    const req = this.#quoteRequest(input.requestId)
    if (req.task_id !== null) throw new BoardError('conflict', 'a quote was already picked')
    if (this.#now() >= req.quote_deadline) throw new BoardError('conflict', 'the quote deadline has passed')
    const ctx = this.#ctx(req.stack)
    const request = JSON.parse(req.request_json) as { tokens: Address[]; budget?: { token: Address; max: string } }
    const token = await this.#resolveToken(ctx, input.token)
    if (!request.tokens.some((t) => eq(t, token)))
      throw new BoardError('invalid', 'that token is not accepted by this request')
    const agentWallet = await sdk.agentWallet(ctx, BigInt(input.agentId)).catch(() => zeroAddress)
    if (!eq(agentWallet, me))
      throw new BoardError('forbidden', `agent ${input.agentId}'s registered wallet is ${agentWallet}, not ${me}`)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    let amount: bigint
    try {
      amount = parseUnits(input.amount, decimals)
    } catch {
      throw new BoardError('invalid', 'amount must be a decimal number')
    }
    if (amount <= 0n) throw new BoardError('invalid', 'the amount must be positive')
    if (request.budget !== undefined && amount > BigInt(request.budget.max)) {
      throw new BoardError(
        'invalid',
        `this request's budget is at most ${formatUnits(BigInt(request.budget.max), decimals)}; quote at or below it`,
      )
    }
    let expectedCosts: { token: Address; amount: string; note: string } | undefined
    if (input.expectedCosts !== undefined) {
      const costToken = await this.#advanceToken(ctx, input.expectedCosts.token)
      const costDecimals = await ctx.publicClient.readContract({
        address: costToken,
        abi: erc20Abi,
        functionName: 'decimals',
      })
      let cost: bigint
      try {
        cost = parseUnits(input.expectedCosts.amount, costDecimals)
      } catch {
        throw new BoardError('invalid', 'expected costs must be a decimal number')
      }
      if (cost <= 0n) throw new BoardError('invalid', 'expected costs must be positive (omit them for none)')
      expectedCosts = { token: costToken, amount: cost.toString(), note: input.expectedCosts.note ?? '' }
    }
    // Declared costs enter the hash only when present, so a quote without them hashes as before.
    const quote = {
      requestHash: req.request_hash,
      worker: me,
      agentId: input.agentId,
      token,
      amount: amount.toString(),
      note: input.note ?? '',
      ...(expectedCosts === undefined ? {} : { expectedCosts }),
    }
    const quoteHash = sdk.hashText(canonicalJson(quote))
    const id = randomId(8)
    const costsJson = expectedCosts === undefined ? null : JSON.stringify(expectedCosts)
    this.#sql.run(
      `INSERT INTO quotes (id, request_id, worker, agent_id, token, amount, note, quote_hash, created_at, expected_costs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id, worker) DO UPDATE SET agent_id = excluded.agent_id, token = excluded.token, amount = excluded.amount, note = excluded.note, quote_hash = excluded.quote_hash, created_at = excluded.created_at, expected_costs_json = excluded.expected_costs_json`,
      id,
      req.id,
      me,
      input.agentId,
      token,
      amount.toString(),
      quote.note,
      quoteHash,
      this.#now(),
      costsJson,
    )
    const [row] = this.#sql.all<QuoteRow>('SELECT * FROM quotes WHERE request_id = ? AND worker = ?', req.id, me)
    return {
      quoteId: row?.id ?? id,
      quoteHash,
      next: 'If the publisher picks your quote, the offer is published and you are selected; then prepare_activation.',
    }
  }

  /** The publisher sees every quote on its request; a bidder sees only its own. */
  async listQuotes(caller: Caller, input: { requestId: string }) {
    const me = this.#requireCaller(caller)
    const req = this.#quoteRequest(input.requestId)
    const all = eq(req.creator, me)
    const ctx = this.#ctx(req.stack)
    const out = []
    for (const q of this.#sql.all<QuoteRow>('SELECT * FROM quotes WHERE request_id = ? ORDER BY created_at', req.id)) {
      if (!all && !eq(q.worker, me)) continue
      const [symbol, decimals] = await Promise.all([
        ctx.publicClient.readContract({ address: q.token as Address, abi: erc20Abi, functionName: 'symbol' }),
        ctx.publicClient.readContract({ address: q.token as Address, abi: erc20Abi, functionName: 'decimals' }),
      ])
      out.push({
        quoteId: q.id,
        worker: q.worker,
        agentId: q.agent_id,
        token: q.token,
        symbol,
        amount: formatUnits(BigInt(q.amount), decimals),
        note: q.note,
        expectedCosts:
          q.expected_costs_json === null
            ? null
            : await this.#displayAmount(
                ctx,
                JSON.parse(q.expected_costs_json) as { token: Address; amount: string; note: string },
              ),
        quoteHash: q.quote_hash,
      })
    }
    return {
      requestId: req.id,
      requestHash: req.request_hash,
      creator: req.creator,
      picked: req.task_id,
      invite: this.#requestInvite(req),
      quotes: out,
    }
  }

  /**
   * The publisher picks a quote (no automatic lowest bid): the ordinary escrow-backed offer is frozen with the quote's
   * token and amount and both hashes, and the bidder's application is recorded. Then: send the publish transactions,
   * report_transaction, select_worker with the returned applicationId, submit_selection.
   */
  async pickQuote(
    caller: Caller,
    input: {
      requestId: string
      quoteId: string
      /**
       * The execution budget the creator approves (ADR-0005), possibly less than the worker declared. The token
       * defaults to the declared costs' token, else the reward token; the expiry to the delivery deadline.
       */
      executionBudget?: BudgetInput
      idempotencyKey?: string
    },
  ) {
    const me = this.#requireCaller(caller)
    const saved = this.#idempotent<TaskPreparation & { applicationId: string }>(me, 'pick_quote', input.idempotencyKey)
    if (saved !== undefined) {
      this.#task(saved.taskId)
      return saved
    }
    const taskKey =
      input.idempotencyKey === undefined ? undefined : `pick-${sdk.hashText(input.idempotencyKey).slice(2)}`
    // A crash can leave pick_task committed before pick_quote. Refuse a retired nested preparation before even
    // reading token metadata for the reused stack name.
    const taskSaved = this.#idempotent<TaskPreparation>(me, 'pick_task', taskKey)
    if (taskSaved !== undefined) this.#task(taskSaved.taskId)
    const req = this.#quoteRequest(input.requestId)
    if (!eq(req.creator, me)) throw new BoardError('forbidden', 'only the requester picks a quote')
    if (req.task_id !== null) throw new BoardError('conflict', `already picked: task ${req.task_id}`)
    const [q] = this.#sql.all<QuoteRow>('SELECT * FROM quotes WHERE id = ? AND request_id = ?', input.quoteId, req.id)
    if (q === undefined) throw new BoardError('not-found', 'no such quote')
    const ctx = this.#ctx(req.stack)
    const { budget } = JSON.parse(req.request_json) as { budget?: { token: Address; max: string } }
    if (budget !== undefined && (!eq(budget.token, q.token as Address) || BigInt(q.amount) > BigInt(budget.max))) {
      throw new BoardError('conflict', 'that quote is above the request budget')
    }
    const r = JSON.parse(req.request_json) as {
      title: string
      brief: string
      acceptanceCriteria: string[]
      creatorBond: string
      workerBond: string
      deliveryDeadline: number
      approver: Address
      requiredChecks: string[]
      deliverable?: DeliverableSpec
      windows?: import('./terms.ts').EvaluatorWindows
      arbitrator?: Address
      tags?: sdk.JobTag[]
    }
    const decimals = await ctx.publicClient.readContract({
      address: q.token as Address,
      abi: erc20Abi,
      functionName: 'decimals',
    })
    const created = await this.createTask(
      caller,
      {
        ...(taskKey === undefined ? {} : { idempotencyKey: taskKey }),
        title: r.title,
        brief: r.brief,
        acceptanceCriteria: r.acceptanceCriteria,
        ...(r.tags === undefined ? {} : { tags: r.tags }),
        token: q.token,
        reward: formatUnits(BigInt(q.amount), decimals),
        creatorBond: r.creatorBond,
        workerBond: r.workerBond,
        deliveryDeadline: r.deliveryDeadline,
        stack: req.stack as sdk.StackName,
        approver: r.approver,
        ...(r.windows === undefined ? {} : { windows: r.windows }),
        ...(r.arbitrator === undefined ? {} : { arbitrator: r.arbitrator }),
        ...(r.requiredChecks.length === 0 ? {} : { requiredChecks: r.requiredChecks }),
        ...(r.deliverable === undefined ? {} : { deliverable: r.deliverable }),
        ...(input.executionBudget === undefined
          ? {}
          : {
              executionBudget:
                input.executionBudget.kind === 'call'
                  ? input.executionBudget
                  : {
                      ...input.executionBudget,
                      token:
                        input.executionBudget.token ??
                        (q.expected_costs_json === null
                          ? q.token
                          : (JSON.parse(q.expected_costs_json) as { token: string }).token),
                    },
            }),
      },
      { requestHash: req.request_hash as Hex, quoteHash: q.quote_hash as Hex },
    )
    return this.#persist(() => {
      const picked = this.#idempotent<TaskPreparation & { applicationId: string }>(
        me,
        'pick_quote',
        input.idempotencyKey,
      )
      if (picked !== undefined) {
        this.#task(picked.taskId)
        return picked
      }
      this.#sql.run('UPDATE quote_requests SET task_id = ? WHERE id = ?', created.taskId, req.id)
      const applicationId = randomId(8)
      this.#sql.run(
        'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        applicationId,
        created.taskId,
        q.worker,
        q.agent_id,
        `picked quote ${q.id}`,
        this.#now(),
      )
      return this.#remember(me, 'pick_quote', input.idempotencyKey, {
        ...created,
        applicationId,
        next: 'Send the transactions, report_transaction with the publish hash, then select_worker({taskId, applicationId}).',
      })
    })
  }

  // -----------------------------------------------------------------------------------------------
  // Worker
  // -----------------------------------------------------------------------------------------------

  /**
   * Refuses to prepare a worker's commitment against a listing that differs from the frozen offer: the contract keys
   * a listing by `policyHash` only, so a creator could publish the board's terms hash with, e.g., a larger worker
   * bond. The worker signs and approves exactly the offer's amounts, never the listing's.
   */
  async #requireListingMatches(task: TaskRow) {
    const view = await this.#chainView(task)
    if (view.listingMatchesOffer !== true) {
      throw new BoardError(
        'conflict',
        'the on-chain listing does not match the published offer (reward, bonds, deadlines or approver); do not take this job',
      )
    }
    return view
  }

  /** Applies with a registered ERC-8004 agent whose agent wallet is the signed-in wallet. */
  async apply(caller: Caller, input: { taskId: string; agentId: string; note?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (task.job_id === null && (await this.#recoverPublish(task)) === null)
      throw new BoardError('conflict', 'this offer is not funded on-chain yet')
    await this.#requireListingMatches(task)
    const ctx = this.#taskCtx(task)
    const agentWallet = await sdk.agentWallet(ctx, BigInt(input.agentId)).catch(() => zeroAddress)
    if (!eq(agentWallet, me)) {
      throw new BoardError('forbidden', `agent ${input.agentId}'s registered wallet is ${agentWallet}, not ${me}`)
    }
    const id = randomId(8)
    this.#sql.run(
      'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (task_id, worker) DO UPDATE SET agent_id = excluded.agent_id, note = excluded.note',
      id,
      task.id,
      me,
      input.agentId,
      input.note ?? '',
      this.#now(),
    )
    const [row] = this.#sql.all<ApplicationRow>(
      'SELECT * FROM applications WHERE task_id = ? AND worker = ?',
      task.id,
      me,
    )
    return { applicationId: row?.id ?? id, next: 'Wait for the creator to select you; then prepare_activation.' }
  }

  /**
   * For a selected worker: the creator's signed Selection and the net budget authorisation to sign. Activation is the worker's own transaction (R114-01).
   */
  async prepareActivation(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const sel = this.#liveSelectionFor(task, me)
    await this.#requireListingMatches(task)
    const ctx = this.#taskCtx(task)
    const terms = parseTerms(task.terms_json)
    const budgetNonce = randomUint(9)
    const feeQuote = await sidequest.activationQuote(ctx, this.#jobId(task), me, terms)
    const budgetDeadline = this.#now() + 3600
    this.#sql.run(
      'INSERT INTO activation_preps (task_id, worker, nonce, budget_nonce, budget_deadline) VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, worker) DO UPDATE SET nonce = excluded.nonce, budget_nonce = excluded.budget_nonce, budget_deadline = excluded.budget_deadline',
      task.id,
      me,
      sel.nonce,
      budgetNonce.toString(),
      budgetDeadline,
    )
    return {
      selection: this.#selection(task, sel),
      activateBy: sel.activate_by,
      transactions: [],
      feeQuote: { feeBps: feeQuote.feeBps, fee: feeQuote.fee.toString(), net: feeQuote.net.toString() },
      sign: {
        description:
          'SetBudgetAuthorization for the quoted worker payment: sign with your wallet, then build_activation with the signature',
        typedData: typedDataJson(
          sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core),
          sdk.setBudgetTypes,
          'SetBudgetAuthorization',
          {
            signer: me,
            jobId: this.#jobId(task),
            token: terms.token,
            amount: feeQuote.net,
            optParamsHash: sdk.EMPTY_HASH,
            nonce: budgetNonce,
            deadline: BigInt(budgetDeadline),
          },
        ),
      } satisfies SignRequest,
      next: 'Sign the quoted net budget authorization, then build_activation({ taskId, budgetSignature }) to confirm activation and reserve your bond from stake.',
    }
  }

  /** The worker's newest signed selection on this task that can still be activated, if any. Board records only. */
  #liveSelection(task: TaskRow, worker: Address): SelectionRow | undefined {
    return this.#sql
      .all<SelectionRow>(
        'SELECT * FROM selections WHERE task_id = ? AND signature IS NOT NULL AND activate_by >= ? ORDER BY created_at DESC',
        task.id,
        this.#now(),
      )
      .find((r) => eq(r.worker, worker))
  }

  #liveSelectionFor(task: TaskRow, worker: Address): SelectionRow {
    const sel = this.#liveSelection(task, worker)
    if (sel === undefined) throw new BoardError('not-found', 'you have no live signed selection for this task')
    return sel
  }

  /** The `activate` transaction, from the worker's signed budget authorisation. */
  async buildActivation(caller: Caller, input: { taskId: string; budgetSignature: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const sel = this.#liveSelectionFor(task, me)
    await this.#requireListingMatches(task)
    const [prep] = this.#sql.all<{ nonce: string; budget_nonce: string; budget_deadline: number }>(
      'SELECT nonce, budget_nonce, budget_deadline FROM activation_preps WHERE task_id = ? AND worker = ?',
      task.id,
      me,
    )
    if (prep === undefined || prep.nonce !== sel.nonce)
      throw new BoardError('conflict', 'call prepare_activation first')
    const ctx = this.#taskCtx(task)
    const terms = parseTerms(task.terms_json)
    {
      const quote = await sidequest.activationQuote(ctx, this.#jobId(task), me, terms)
      const valid = await ctx.publicClient.verifyTypedData({
        address: me,
        domain: sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core),
        types: sdk.setBudgetTypes,
        primaryType: 'SetBudgetAuthorization',
        message: {
          signer: me,
          jobId: this.#jobId(task),
          token: terms.token,
          amount: quote.net,
          optParamsHash: sdk.EMPTY_HASH,
          nonce: BigInt(prep.budget_nonce),
          deadline: BigInt(prep.budget_deadline),
        },
        signature: input.budgetSignature as Hex,
      })
      if (!valid)
        throw new BoardError(
          'conflict',
          'The budget signature does not match the current net quote; call prepare_activation and sign the new quote.',
        )
    }
    this.#operation(task.id, 'activate', me, { selectionNonce: sel.nonce })
    return {
      transactions: [
        this.#tx(
          ctx,
          'activate: your final confirmation; sets you as provider, posts your bond, funds the job',
          ctx.stack.holding,
          encodeFunctionData({
            abi: sidequest.holdingAbi(ctx),
            functionName: 'activate',
            args: [
              this.#selection(task, sel),
              sel.signature as Hex,
              {
                signer: me,
                nonce: BigInt(prep.budget_nonce),
                deadline: BigInt(prep.budget_deadline),
                sig: input.budgetSignature as Hex,
              },
            ],
          }),
        ),
      ],
      next: 'Send them in order (or as one batch) from your wallet, then report_transaction for each hash.',
    }
  }

  /** Records the deliverable (public fork, branch, full SHA) and returns the final `submit` transaction. */
  async submitWork(
    caller: Caller,
    input: { taskId: string; deliverable?: unknown; repo?: string; branch?: string; sha?: string },
  ) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const ctx = this.#taskCtx(task)
    const job = await sdk.getJob(ctx, this.#jobId(task))
    if (!eq(job.provider, me)) throw new BoardError('forbidden', 'only the activated worker submits')
    const deliverable = this.#acceptedDeliverable(parseTerms(task.terms_json), input)
    const deliverableHash = hashDeliverable(deliverable)
    const check = await this.#checkDeliverable(deliverable)
    const cols = legacyColumns(deliverable)
    this.#sql.run(
      `INSERT INTO deliverables (task_id, worker, deliverable_hash, repo, branch, sha, kind, descriptor_json, check_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, deliverable_hash) DO UPDATE SET check_json = excluded.check_json`,
      task.id,
      me,
      deliverableHash,
      cols.repo,
      cols.branch,
      cols.sha,
      deliverable.kind,
      canonicalJson(deliverable),
      JSON.stringify(check),
      this.#now(),
    )
    this.#operation(task.id, 'submit', me, { deliverableHash })
    return {
      deliverableHash,
      deliverable,
      check,
      transactions: [
        this.#tx(
          ctx,
          'submit: your one final submission of this deliverable',
          ctx.deployment.core,
          encodeFunctionData({
            abi: sdk.coreAbi,
            functionName: 'submit',
            args: [this.#jobId(task), deliverableHash, '0x'],
          }),
        ),
      ],
    }
  }

  /** The worker disputes; an optional statement goes into the dispute bundle the arbitrator reads. */
  async disputeRejection(caller: Caller, input: { taskId: string; statement?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const ctx = this.#taskCtx(task)
    if (input.statement !== undefined && input.statement.trim() !== '') {
      // Stored under the worker's role only for the job's provider: the bundle's roles are what the arbiter weighs.
      const view = await this.#chainView(task)
      if (!eq(view.provider ?? zeroAddress, me))
        throw new BoardError('forbidden', 'only the worker disputes and adds a worker statement')
      this.#statement(task, me, 'worker', input.statement)
    }
    this.#operation(task.id, 'dispute', me)
    return {
      transactions: [
        this.#tx(
          ctx,
          'dispute: freezes acceptance; only a ruling or the arbitration timeout settles',
          ctx.stack.evaluator,
          encodeFunctionData({ abi: sidequest.evaluatorAbi(ctx), functionName: 'dispute', args: [this.#jobId(task)] }),
        ),
      ],
    }
  }

  /** A party's statement for the arbitrator (creator, approver or worker), while a rejection is pending or disputed. */
  async addStatement(caller: Caller, input: { taskId: string; text: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const view = await this.#chainView(task)
    if (view.status !== 'rejected-pending' && view.status !== 'disputed')
      throw new BoardError('conflict', `nothing to argue: the task is ${view.status}`)
    const roles = this.#roles(parseTerms(task.terms_json), view, me)
    if (roles.length === 0) throw new BoardError('forbidden', 'only the creator, approver or worker adds statements')
    this.#statement(task, me, roles.join('+'), input.text)
    return { ok: true }
  }

  #statement(task: TaskRow, author: Address, role: string, text: string) {
    if (text.length > 4000) throw new BoardError('invalid', 'a statement is at most 4000 characters')
    this.#sql.run(
      'INSERT INTO statements (id, task_id, author, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      randomId(8),
      task.id,
      author,
      role,
      text,
      this.#now(),
    )
  }

  // -----------------------------------------------------------------------------------------------
  // Evidence (the attester)
  // -----------------------------------------------------------------------------------------------

  /**
   * The attester reads the GitHub check runs of a hire's recorded deliverable SHA, signs an `EvidenceAttestation` bound to this offer's policy and that deliverable, and the
   * relay attaches it on-chain. Evidence is advisory: it moves no money and gates nothing.
   */
  async requestEvidence(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const cfg = this.#config.evidence
    if (cfg === undefined) throw new BoardError('invalid', 'the attester is not configured on this board (unavailable)')
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const terms = parseTerms(task.terms_json)
    const ctx = this.#taskCtx(task)
    const target = this.#sql.all<{ repo: string; sha: string; deliverable_hash: string }>(
      'SELECT repo, sha, deliverable_hash FROM deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      task.id,
    )[0]
    if (target === undefined) throw new BoardError('not-found', 'no deliverable to attest')
    // The relay pays for each attestation: only the parties may ask for one.
    if (this.#roles(terms, await this.#chainView(task), me).length === 0) {
      throw new BoardError('forbidden', 'only the creator, approver, worker asks for evidence')
    }
    const [already] = this.#sql.all<{ conclusion: number; tx_hash: string }>(
      'SELECT conclusion, tx_hash FROM evidence WHERE task_id = ? AND submission_hash = ? AND tested_sha = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
      task.id,
      target.deliverable_hash,
      target.sha,
      this.#now() - 6 * 24 * 3600,
    )
    if (already !== undefined)
      return {
        conclusion: already.conclusion === sdk.EvidenceConclusion.Success ? 'success' : 'failure',
        txHash: already.tx_hash,
        reused: true,
      }
    const slug = repoSlug(target.repo)
    if (slug === undefined) throw new BoardError('invalid', 'only public GitHub repositories are attested')
    const token = cfg.github === undefined ? undefined : await installationToken(cfg.github, this.#now())
    const runs = await checkRuns(token, slug, target.sha)
    const required = terms.evidencePolicy?.checks ?? []
    const relevant = required.length === 0 ? runs : runs.filter((r) => required.includes(r.name))
    if (relevant.length === 0)
      throw new BoardError('conflict', `no ${required.length === 0 ? '' : 'required '}check runs on ${target.sha} yet`)
    if (relevant.some((r) => r.status !== 'completed'))
      throw new BoardError('conflict', 'checks are still running; ask again when they finish')
    const missing = required.filter((name) => !relevant.some((r) => r.name === name))
    const success = missing.length === 0 && relevant.every((r) => r.conclusion === 'success')
    const checks = relevant.map((r) => ({ name: r.name, conclusion: r.conclusion, app: r.app, sha: r.head_sha }))
    const shaWord = `0x${target.sha.padStart(64, '0')}` as Hex
    const attestation = {
      jobId: this.#jobId(task),
      submissionHash: target.deliverable_hash as Hex,
      policyHash: task.terms_hash as Hex,
      repo: sdk.hashText(target.repo),
      headSha: shaWord,
      testedSha: shaWord,
      checkRunsHash: sdk.hashText(canonicalJson({ checks, missing })),
      conclusion: success ? sdk.EvidenceConclusion.Success : sdk.EvidenceConclusion.Failure,
      validUntil: BigInt(this.#now() + 7 * 24 * 3600),
    }
    const signature = await cfg.attester.signTypedData({
      domain: sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
      types: sdk.evidenceTypes,
      primaryType: 'EvidenceAttestation',
      message: attestation,
    })
    const hash = await this.#sendRelay({
      key: `evidence:${ctx.stack.evaluator}:${sdk.hashText(canonicalJson(attestation))}:${signature}`,
      to: ctx.stack.evaluator,
      data: encodeFunctionData({
        abi: sidequest.evaluatorAbi(ctx),
        functionName: 'attachEvidence',
        args: [attestation.jobId, attestation, cfg.attester.address, signature],
      }),
    })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
    this.#sql.run(
      'INSERT INTO evidence (id, task_id, submission_hash, verifier, conclusion, tested_sha, checks_json, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      randomId(8),
      task.id,
      target.deliverable_hash,
      cfg.attester.address,
      attestation.conclusion,
      target.sha,
      JSON.stringify({ checks, missing }),
      receipt.transactionHash,
      this.#now(),
    )
    return {
      conclusion: success ? 'success' : 'failure',
      checks,
      missing,
      txHash: receipt.transactionHash,
      evidence: this.#evidence(task),
    }
  }

  /**
   * Every evidence statement on this task with its label (R114-06): "matches the on-chain deliverable" only
   * when it names the deliverable the core recorded in `JobSubmitted`; before that, "matches this submitted
   * candidate" when it names a deliverable the board recorded. A job id alone is never a match.
   */
  #evidence(task: TaskRow) {
    const onchain = this.#sql.all<{ deliverable_hash: string }>(
      'SELECT deliverable_hash FROM onchain_submissions WHERE task_id = ?',
      task.id,
    )[0]
    const known = new Set(
      [
        ...this.#sql.all<{ h: string }>('SELECT deliverable_hash AS h FROM deliverables WHERE task_id = ?', task.id),
      ].map((r) => r.h.toLowerCase()),
    )
    return this.#sql
      .all<{
        submission_hash: string
        verifier: string
        conclusion: number
        tested_sha: string
        checks_json: string
        tx_hash: string
        created_at: number
      }>(
        'SELECT submission_hash, verifier, conclusion, tested_sha, checks_json, tx_hash, created_at FROM evidence WHERE task_id = ? ORDER BY created_at',
        task.id,
      )
      .map((e) => ({
        verifier: e.verifier,
        submissionHash: e.submission_hash,
        conclusion: e.conclusion === 1 ? 'success' : 'failure',
        testedSha: e.tested_sha,
        checks: JSON.parse(e.checks_json) as unknown,
        txHash: e.tx_hash,
        label: eq(onchain?.deliverable_hash, e.submission_hash)
          ? 'matches the on-chain deliverable'
          : known.has(e.submission_hash.toLowerCase())
            ? 'matches this submitted deliverable'
            : 'unmatched',
      }))
  }

  async #arbitratorOf(task: TaskRow): Promise<Address> {
    const ctx = this.#taskCtx(task)
    return (await sdk.termsOf(ctx, this.#jobId(task))).arbitrator
  }

  async #requireArbitrator(caller: Caller, task: TaskRow): Promise<Address> {
    const me = this.#requireCaller(caller)
    if (!eq(await this.#arbitratorOf(task), me)) throw new BoardError('forbidden', 'only this job’s named arbitrator')
    return me
  }

  async #knownArbitrator(me: Address): Promise<boolean> {
    for (const task of this.#sql.all<TaskRow>('SELECT * FROM tasks WHERE job_id IS NOT NULL')) {
      if (this.#findTaskCtx(task) === undefined) continue
      if (eq(await this.#arbitratorOf(task), me)) return true
    }
    for (const ctx of Object.values(this.#config.contexts)) {
      if (ctx === undefined) continue
      const address = await ctx.publicClient.readContract({
        address: ctx.stack.holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'defaultArbitrator',
      })
      if (eq(address, me)) return true
    }
    return false
  }

  /**
   * One runner per arbitrator key (plan B2.4): a runner takes or renews the lease; another runner is told who holds
   * it until when. Rulings refuse a runner without the lease, so two harnesses never decide the same dispute.
   */
  async arbiterLease(caller: Caller, input: { runner: string; ttlSeconds?: number; release?: boolean }) {
    const me = this.#requireCaller(caller)
    if (!(await this.#knownArbitrator(me)))
      throw new BoardError('forbidden', 'only an arbitrator key holds an arbiter lease')
    const key = me.toLowerCase()
    const now = this.#now()
    const [lease] = this.#sql.all<{ runner: string; expires_at: number }>(
      'SELECT runner, expires_at FROM arbiter_leases WHERE arbitrator = ?',
      key,
    )
    if (lease !== undefined && lease.runner !== input.runner && lease.expires_at > now) {
      return { held: false, holder: lease.runner, expiresAt: lease.expires_at }
    }
    if (input.release === true) {
      this.#sql.run('DELETE FROM arbiter_leases WHERE arbitrator = ? AND runner = ?', key, input.runner)
      return { held: false, holder: null, expiresAt: null }
    }
    const expiresAt = now + Math.min(Math.max(input.ttlSeconds ?? 120, 30), 900)
    this.#sql.run(
      'INSERT OR REPLACE INTO arbiter_leases (arbitrator, runner, expires_at) VALUES (?, ?, ?)',
      key,
      input.runner,
      expiresAt,
    )
    return { held: true, holder: input.runner, expiresAt }
  }

  #requireLease(arbitrator: Address, runner: string) {
    const [lease] = this.#sql.all<{ runner: string; expires_at: number }>(
      'SELECT runner, expires_at FROM arbiter_leases WHERE arbitrator = ?',
      arbitrator.toLowerCase(),
    )
    if (lease !== undefined && lease.runner !== runner && lease.expires_at > this.#now()) {
      throw new BoardError('conflict', `runner ${lease.runner} holds the arbiter lease until ${lease.expires_at}`)
    }
  }

  /** Every open dispute the caller arbitrates, with its deadline and any decision already recorded. */
  async listDisputes(caller: Caller) {
    const me = this.#requireCaller(caller)
    if (!(await this.#knownArbitrator(me)))
      throw new BoardError('forbidden', 'arbitrator tools need a session signed in with the arbitrator wallet')
    const out = []
    for (const task of this.#sql.all<TaskRow>('SELECT * FROM tasks WHERE job_id IS NOT NULL ORDER BY created_at')) {
      if (this.#findTaskCtx(task) === undefined) continue
      if (!eq(await this.#arbitratorOf(task), me)) continue
      const ctx = this.#taskCtx(task)
      const disputedAt = await ctx.publicClient.readContract({
        address: ctx.stack.evaluator,
        abi: sidequest.evaluatorAbi(ctx),
        functionName: 'disputedAt',
        args: [this.#jobId(task)],
      })
      if (disputedAt === 0) continue
      const view = await this.#chainView(task)
      if (
        view.status !== 'disputed' ||
        view.deferredDecision ||
        (view.outcome !== undefined && view.outcome !== 'None')
      )
        continue
      const decision = this.#ruling(task.id, disputedAt)
      out.push({
        taskId: task.id,
        jobId: task.job_id,
        stack: task.stack,
        arbitrator: me,
        evaluator: ctx.stack.evaluator,
        kind: ctx.stack.kind,
        title: parseTerms(task.terms_json).title,
        violation: view.violation,
        arbitrationEndsAt: view.arbitrationEndsAt,
        decision: decision === undefined ? null : this.#decisionView(decision),
      })
    }
    return out
  }

  /** A recorded decision as every harness sees it: re-used as is, never re-asked of a model (R114-08). */
  #decisionView(r: RulingRow) {
    const reason =
      this.#sql.all<{ text: string }>('SELECT text FROM reasons WHERE hash = ?', r.reason_hash)[0]?.text ?? null
    return {
      forWorker: r.for_worker === 1,
      slashLoser: r.slash_loser === 1,
      reason,
      reasonHash: r.reason_hash,
      runner: r.runner,
      model: r.model,
      promptVersion: r.prompt_version,
      signed: r.signature !== null,
      txHash: r.tx_hash,
    }
  }

  #ruling(taskId: string, disputedAt: number): RulingRow | undefined {
    return this.#sql.all<RulingRow>(
      'SELECT * FROM rulings WHERE task_id = ? AND disputed_at = ?',
      taskId,
      disputedAt,
    )[0]
  }

  /**
   * The whole dispute as the arbitrator decides it: the offer, the rejection and its published reason, the on-chain
   * deliverable, the attested evidence with its label, and both sides' statements. Readable by the arbitrator and
   * the parties. `bundleHash` pins the decision to exactly this bundle.
   */
  async getDisputeBundle(caller: Caller, input: { taskId: string }): Promise<DisputeBundleReply> {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const bundle = await this.#bundle(task)
    const terms = parseTerms(task.terms_json)
    const view = await this.#chainView(task)
    if (!eq(bundle.arbitrator, me) && this.#roles(terms, view, me).length === 0)
      throw new BoardError('forbidden', 'only the arbitrator and the parties')
    return withDisputeThread(bundle, this.#config.disputeThread)
  }

  async #bundle(task: TaskRow): Promise<DisputeBundle> {
    const ctx = this.#taskCtx(task)
    const jobId = this.#jobId(task)
    const terms = parseTerms(task.terms_json)
    const [disputedAt, reasonHash, view, arbitrator] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.stack.evaluator,
        abi: sidequest.evaluatorAbi(ctx),
        functionName: 'disputedAt',
        args: [jobId],
      }),
      ctx.publicClient.readContract({
        address: ctx.stack.evaluator,
        abi: sidequest.evaluatorAbi(ctx),
        functionName: 'rejectionReasonOf',
        args: [jobId],
      }),
      this.#chainView(task),
      this.#arbitratorOf(task),
    ])
    if (disputedAt === 0) throw new BoardError('conflict', 'this job has not been disputed')
    const reason = this.#sql.all<{ text: string }>('SELECT text FROM reasons WHERE hash = ?', reasonHash)[0]
    const onchain = this.#sql.all<{ deliverable_hash: string }>(
      'SELECT deliverable_hash FROM onchain_submissions WHERE task_id = ?',
      task.id,
    )[0]
    const deliverable =
      onchain === undefined
        ? undefined
        : this.#sql
            .all<{
              repo: string
              branch: string
              sha: string
              kind: string | null
              descriptor_json: string | null
              check_json: string | null
            }>(
              'SELECT repo, branch, sha, kind, descriptor_json, check_json FROM deliverables WHERE task_id = ? AND lower(deliverable_hash) = lower(?)',
              task.id,
              onchain.deliverable_hash,
            )
            .map(({ repo, branch, sha, ...rest }) => {
              const v = deliverableView({ repo, branch, sha, ...rest })
              return { repo, branch, sha, descriptor: v.descriptor, check: v.check }
            })[0]
    return {
      taskId: task.id,
      jobId: jobId.toString(),
      stack: task.stack,
      chainId: ctx.deployment.chainId,
      evaluator: ctx.stack.evaluator,
      arbitrator,
      disputedAt,
      arbitrationEndsAt: view.arbitrationEndsAt ?? disputedAt + terms.windows.arbitrationSeconds,
      offer: {
        title: terms.title,
        brief: terms.brief,
        acceptanceCriteria: terms.acceptanceCriteria,
        reward: terms.reward.toString(),
        token: terms.token,
        creatorBond: terms.creatorBond.toString(),
        workerBond: terms.workerBond.toString(),
        deliveryDeadline: terms.deliveryDeadline,
      },
      rejection: {
        violation: (view.violation ?? 'None') as ViolationName,
        reasonHash,
        // Only text whose hash is the on-chain reason hash counts as the published reason.
        reasonText: reason === undefined || sdk.hashText(reason.text) !== reasonHash ? null : reason.text,
      },
      submission: {
        deliverableHash: (onchain?.deliverable_hash ?? null) as Hex | null,
        submittedAt: view.submittedAt,
        timely: view.timely,
      },
      deliverable: deliverable ?? null,
      evidence: this.#evidence(task).map((e) => ({
        conclusion: e.conclusion,
        label: e.label,
        checks: e.checks,
        txHash: e.txHash,
      })),
      statements: this.#sql
        .all<{ role: string; text: string }>(
          'SELECT role, text FROM statements WHERE task_id = ? ORDER BY created_at, id',
          task.id,
        )
        .map((r) => ({ role: r.role, text: r.text })),
    }
  }

  /**
   * Records the arbitrator's decision for this dispute and returns the EIP-712 `Ruling` to sign. The decision is
   * persisted per dispute: the first one is final on the board (a different decision is refused; the same one returns
   * the same message), it must be made on the current bundle, by the runner holding the lease, within the window.
   */
  async prepareRuling(
    caller: Caller,
    input: {
      taskId: string
      forWorker: boolean
      slashLoser: boolean
      reason: string
      bundleHash: string
      runner: string
      model?: string
      promptVersion?: string
    },
  ) {
    const task = this.#task(input.taskId)
    const me = await this.#requireArbitrator(caller, task)
    this.#requireLease(me, input.runner)
    const bundle = await this.#bundle(task)
    const view = await this.#chainView(task)
    if (view.status !== 'disputed' || view.deferredDecision || (view.outcome !== undefined && view.outcome !== 'None'))
      throw new BoardError('conflict', 'the job no longer has an unresolved dispute')
    const now = this.#now()
    if (now >= bundle.arbitrationEndsAt)
      throw new BoardError('conflict', 'the arbitration window has closed; only the refund timeout settles')
    const recorded = this.#ruling(task.id, bundle.disputedAt)
    // A recorded decision is re-used as is (another harness, a retry); a new one must be made on the current bundle.
    if (recorded === undefined && !eq(bundleHash(bundle), input.bundleHash))
      throw new BoardError('conflict', 'the dispute bundle changed; read it again')
    const refusal = rulingRefusal(bundle.rejection.violation, input.forWorker, input.slashLoser)
    if (refusal !== undefined) throw new BoardError('invalid', refusal)
    if (input.reason.trim().length < 20 || input.reason.length > 2000)
      throw new BoardError('invalid', 'the reason is 20 to 2000 characters')
    const reasonHash = sdk.hashText(input.reason.trim())
    let row = recorded
    if (row === undefined) {
      this.#sql.run(
        'INSERT OR IGNORE INTO reasons (hash, task_id, text, created_at) VALUES (?, ?, ?, ?)',
        reasonHash,
        task.id,
        input.reason.trim(),
        now,
      )
      this.#sql.run(
        `INSERT INTO rulings (task_id, disputed_at, arbitrator, runner, bundle_hash, for_worker, slash_loser, reason_hash, deadline, nonce, signature, tx_hash, created_at, model, prompt_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        task.id,
        bundle.disputedAt,
        me,
        input.runner,
        input.bundleHash,
        input.forWorker ? 1 : 0,
        input.slashLoser ? 1 : 0,
        reasonHash,
        Math.min(bundle.arbitrationEndsAt, now + 3600),
        randomUint(16).toString(),
        now,
        input.model ?? null,
        input.promptVersion ?? null,
      )
      this.#operation(task.id, 'rule', me, { forWorker: input.forWorker, slashLoser: input.slashLoser, reasonHash })
      row = this.#ruling(task.id, bundle.disputedAt) as RulingRow
    } else if (
      row.for_worker !== (input.forWorker ? 1 : 0) ||
      row.slash_loser !== (input.slashLoser ? 1 : 0) ||
      !eq(row.reason_hash, reasonHash)
    ) {
      throw new BoardError('conflict', 'this dispute already has a different decision recorded')
    }
    const ctx = this.#taskCtx(task)
    if (recorded !== undefined) {
      const spent = await sidequest.rulingNonceUsed(ctx, me, BigInt(row.nonce))
      if (spent) {
        // The case is still unresolved (checked above), so this nonce was cancelled. Preserve the decision,
        // archive its old authorization, and issue a fresh nonce only after the cancellation is onchain.
        this.#sql.run(
          'INSERT OR IGNORE INTO ruling_attempts (task_id, nonce, record_json, created_at) VALUES (?, ?, ?, ?)',
          task.id,
          row.nonce,
          JSON.stringify(row),
          now,
        )
        this.#sql.run(
          'UPDATE rulings SET nonce = ?, deadline = ?, signature = NULL, tx_hash = NULL WHERE task_id = ? AND disputed_at = ? AND nonce = ?',
          randomUint(16).toString(),
          Math.min(bundle.arbitrationEndsAt, now + 3600),
          task.id,
          bundle.disputedAt,
          row.nonce,
        )
        row = this.#ruling(task.id, bundle.disputedAt)!
      } else if (row.deadline <= now) {
        throw new BoardError('conflict', 'cancel_ruling must confirm the old nonce before retrying this decision')
      }
    }
    return {
      decision: this.#decisionView(row),
      ruling: this.#rulingMessage(row),
      sign: {
        description: `Ruling for job ${bundle.jobId}: ${input.forWorker ? 'for the worker' : 'for the creator'}${input.slashLoser ? ', loser slashed' : ''}`,
        typedData: typedDataJson(
          sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
          sdk.rulingTypes,
          'Ruling',
          this.#rulingMessage(row),
        ),
      } satisfies SignRequest,
      next: 'Sign it with the arbitrator key, then submit_ruling({taskId, signature}).',
    }
  }

  #rulingMessage(row: RulingRow): sdk.Ruling {
    return {
      jobId: BigInt(this.#task(row.task_id).job_id as string),
      forWorker: row.for_worker === 1,
      slashLoser: row.slash_loser === 1,
      reasonHash: row.reason_hash as Hex,
      deadline: BigInt(row.deadline),
      nonce: BigInt(row.nonce),
    }
  }

  /**
   * Points the caller's account at the deployment's DeleGator (EIP-7702) with an authorization the caller signed; the
   * relay sends the type-4 transaction. For wallets that sign an authorization but cannot send one: Privy's
   * TEE-backed embedded wallets drop `authorizationList` from a transaction. The relay pays the gas and gains nothing:
   * the authorization names only the DeleGator, and the account's own key keeps control of it.
   */
  async upgradeAccount(caller: Caller, input: { authorization: Record<string, unknown> | string }) {
    const me = this.#requireCaller(caller)
    const ctx = this.#ctx('main')
    const delegator = ctx.deployment.delegation.delegator
    if (eq(await sdk.delegationOf(ctx.publicClient, me), delegator))
      return { upgraded: true, txHash: null, note: 'your account already points at the DeleGator' }
    const relay = this.#config.relay
    if (relay === undefined)
      throw new BoardError(
        'conflict',
        'this board has no relay: send the authorization yourself, in a type-4 transaction to your own address',
      )
    const a =
      typeof input.authorization === 'string' ? authorizationFromRlp(input.authorization) : (input.authorization ?? {})
    const hex = (k: string) => {
      const v = a[k]
      if (typeof v !== 'string' || !isHex(v)) throw new BoardError('invalid', `authorization.${k} must be hex`)
      return v
    }
    const int = (k: string) => {
      const v = a[k]
      if ((typeof v !== 'number' && typeof v !== 'string') || !/^(0x[0-9a-fA-F]+|\d+)$/.test(String(v)))
        throw new BoardError('invalid', `authorization.${k} must be an integer`)
      return Number(v)
    }
    const address = hex('address')
    if (!isAddress(address) || !eq(address, delegator))
      throw new BoardError('invalid', `the authorization must name the DeleGator ${delegator}`)
    if (int('chainId') !== ctx.deployment.chainId)
      throw new BoardError('invalid', `the authorization must be for chain ${ctx.deployment.chainId}`)
    const yParity = int('yParity')
    if (yParity !== 0 && yParity !== 1) throw new BoardError('invalid', 'authorization.yParity must be 0 or 1')
    const authorization = {
      address: getAddress(address),
      chainId: ctx.deployment.chainId,
      nonce: int('nonce'),
      r: hex('r'),
      s: hex('s'),
      yParity,
    }
    if (!eq(await recoverAuthorizationAddress({ authorization }), me))
      throw new BoardError('forbidden', 'the authorization is not signed by your account')
    const nonce = await ctx.publicClient.getTransactionCount({ address: me, blockTag: 'pending' })
    if (authorization.nonce !== nonce)
      throw new BoardError(
        'conflict',
        `the authorization's nonce is ${authorization.nonce} but your account's is ${nonce}: sign it again`,
      )
    const hash = await this.#sendRelay({
      key: `upgrade:${me}:${nonce}:${authorization.r}:${authorization.s}`,
      to: me,
      data: '0x',
      authorizationList: [authorization],
    })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !eq(await sdk.delegationOf(ctx.publicClient, me), delegator)) {
      throw new BoardError('chain', `the upgrade ${hash} did not point your account at the DeleGator`)
    }
    return { upgraded: true, txHash: hash }
  }

  /**
   * The signed ruling: checked against the arbitrator key on the chain, stored, and relayed with
   * `ruleWithSignature` (the relay pays gas and holds no authority). Idempotent: a relayed ruling returns its hash.
   */
  async submitRuling(caller: Caller, input: { taskId: string; signature: string }) {
    this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task)
    const ctx = this.#taskCtx(task)
    const disputedAt = await ctx.publicClient.readContract({
      address: ctx.stack.evaluator,
      abi: sidequest.evaluatorAbi(ctx),
      functionName: 'disputedAt',
      args: [this.#jobId(task)],
    })
    const row = this.#ruling(task.id, disputedAt)
    if (row === undefined) throw new BoardError('not-found', 'no decision recorded; prepare_ruling first')
    if (row.tx_hash !== null)
      return { txHash: row.tx_hash, relayed: true, task: await this.getTask(caller, { taskId: task.id }) }
    const ruling = this.#rulingMessage(row)
    const arbitrator = await this.#arbitratorOf(task)
    const valid = await ctx.publicClient.verifyTypedData({
      address: arbitrator,
      domain: sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
      types: sdk.rulingTypes,
      primaryType: 'Ruling',
      message: { ...ruling },
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'the signature is not the arbitrator’s over this ruling')
    this.#sql.run(
      'UPDATE rulings SET signature = ? WHERE task_id = ? AND disputed_at = ?',
      input.signature,
      task.id,
      disputedAt,
    )
    const tx = this.#tx(
      ctx,
      'ruleWithSignature: settles the dispute as ruled',
      ctx.stack.evaluator,
      encodeFunctionData({
        abi: sidequest.evaluatorAbi(ctx),
        functionName: 'ruleWithSignature',
        args: [ruling, input.signature as Hex],
      }),
      sdk.V1_GAS.evaluator,
    )
    const relay = this.#config.relay
    // A crash after an earlier relay: the nonce is spent, so that ruling is on-chain; never send a second one.
    const spent = await sidequest.rulingNonceUsed(ctx, arbitrator, ruling.nonce)
    if (spent && (await sdk.caseOf(ctx, this.#jobId(task))).outcome === 0)
      throw new BoardError(
        'conflict',
        'the ruling nonce was cancelled; prepare_ruling returns a new nonce for the recorded decision',
      )
    if (spent)
      return {
        relayed: true,
        txHash: null,
        note: 'this ruling is already on-chain (its nonce is spent)',
        task: await this.getTask(caller, { taskId: task.id }),
      }
    if (relay === undefined)
      return { relayed: false, transactions: [tx], next: 'Anyone may send it; then report_transaction.' }
    const hash = await this.#sendRelay({
      key: `ruling:${ctx.stack.evaluator}:${ruling.nonce}:${input.signature}`,
      to: tx.to,
      data: tx.data,
      ...(tx.gas === undefined ? {} : { gas: tx.gas }),
    })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
    this.#sql.run(
      'UPDATE rulings SET tx_hash = ? WHERE task_id = ? AND disputed_at = ?',
      receipt.transactionHash,
      task.id,
      disputedAt,
    )
    this.#sql.run(
      "UPDATE operations SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE task_id = ? AND kind = 'rule' AND status = 'prepared'",
      receipt.transactionHash,
      this.#now(),
      task.id,
    )
    return { txHash: receipt.transactionHash, relayed: true, task: await this.getTask(caller, { taskId: task.id }) }
  }

  /** Voids an unsent v1 ruling before a retry. The decision stays recorded; only its authorization changes. */
  async cancelRuling(caller: Caller, input: { taskId: string }) {
    const task = this.#task(input.taskId)
    const me = await this.#requireArbitrator(caller, task)
    const ctx = this.#taskCtx(task)
    const decision = await sdk.caseOf(ctx, this.#jobId(task))
    if (decision.outcome !== 0) return { resolved: true, nonce: null, transactions: [] }
    const row = this.#ruling(task.id, decision.disputedAt)
    if (row === undefined) throw new BoardError('not-found', 'no recorded ruling to cancel')
    if (await sidequest.rulingNonceUsed(ctx, me, BigInt(row.nonce)))
      return { resolved: false, nonce: row.nonce, transactions: [] }
    this.#operation(task.id, 'cancel-ruling', me, { nonce: row.nonce })
    return {
      resolved: false,
      nonce: row.nonce,
      transactions: [
        this.#tx(
          ctx,
          'Cancel the old ruling authorization before retrying',
          ctx.stack.evaluator,
          encodeFunctionData({
            abi: sdk.sidequestEvaluatorAbi,
            functionName: 'cancelRuling',
            args: [BigInt(row.nonce)],
          }),
        ),
      ],
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Anyone
  // -----------------------------------------------------------------------------------------------

  /** Whatever permissionless step the chain allows now (timeouts, settlement), as transactions anyone may send. */
  async settlementActions(caller: Caller, input: { taskId: string }) {
    const task = this.#task(input.taskId)
    const ctx = this.#taskCtx(task)
    const view = await this.#chainView(task)
    const transactions = await sidequest.settleSidequest(ctx, this.#jobId(task), caller.address, this.#now())
    // An empty list alone reads like a silent failure; say who acts next instead, or that nothing is left.
    return {
      status: view.status,
      transactions,
      ...(transactions.length === 0 ? { note: settlementNote(view, this.#now()) } : {}),
    }
  }

  /**
   * Every task's off-chain record for Explore, without chain reads (Explore takes chain facts from the indexer's
   * D1): the frozen offer's display fields, the job id once published, and Jev's advisory verdict.
   */
  taskIndex(_caller: Caller) {
    return this.#sql
      .all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC')
      .flatMap((t) => {
        const ctx = this.#findTaskCtx(t)
        return ctx === undefined ? [] : [{ t, kind: ctx.stack.kind }]
      })
      .slice(0, 500)
      .map(({ t, kind }) => {
        const terms = parseTerms(t.terms_json)
        const screening =
          t.screening_json === null ? null : (JSON.parse(t.screening_json) as { verdict?: string; reasons?: string[] })
        return {
          taskId: t.id,
          jobId: t.job_id,
          stack: t.stack,
          kind,
          creatorAgentId: t.creator_agent_id ?? null,
          title: terms.title,
          brief: terms.brief,
          acceptanceCriteria: terms.acceptanceCriteria,
          mode: terms.mode,
          tags: terms.tags ?? [],
          token: terms.token,
          reward: terms.reward.toString(),
          creatorBond: terms.creatorBond.toString(),
          workerBond: terms.workerBond.toString(),
          creator: terms.creator,
          approver: terms.approver,
          deliveryDeadline: terms.deliveryDeadline,
          requiredChecks: terms.evidencePolicy?.checks ?? [],
          quoted: terms.quote !== null,
          deliverable: specOf(terms),
          executionBudget:
            terms.executionBudget === undefined
              ? null
              : { ...terms.executionBudget, cap: terms.executionBudget.cap.toString() },
          termsHash: t.terms_hash,
          manifestUrl: `${this.#config.manifestBaseUrl}/${t.terms_hash}.json`,
          screening: { verdict: screening?.verdict ?? 'unscreened', reasons: screening?.reasons ?? [] },
          createdAt: t.created_at,
        }
      })
  }

  /**
   * Newest tasks first, optionally only those where the caller holds a role and those in given chain statuses. Roles
   * come from board records (no RPC). A status needs each task's chain view, so a status filter reads at most the
   * newest LIST_STATUS_SCAN role-matching tasks and may return fewer than `limit`.
   */
  async listTasks(caller: Caller, input: { limit?: number; role?: TaskRole; status?: readonly TaskStatus[] }) {
    const limit = Math.min(input.limit ?? 20, 50)
    let rows = this.#sql
      .all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC')
      .filter((t) => this.#findTaskCtx(t) !== undefined)
    if (input.role !== undefined) {
      if (!TASK_ROLES.includes(input.role))
        throw new BoardError('invalid', `role must be one of ${TASK_ROLES.join(', ')}`)
      const me = caller.address
      if (me === undefined) throw new BoardError('unauthenticated', 'a role filter needs a signed-in caller')
      const role = input.role
      const applied =
        role === 'worker' || role === 'invited'
          ? new Set(
              this.#sql
                .all<{ task_id: string }>(
                  `SELECT DISTINCT task_id FROM applications WHERE lower(worker) = ?${role === 'invited' ? " AND (note = 'direct hire invitation' OR note LIKE 'picked quote %')" : ''}`,
                  me.toLowerCase(),
                )
                .map((row) => row.task_id),
            )
          : undefined
      rows = rows.filter((t) =>
        role === 'creator'
          ? this.#actsForCreator(t, me)
          : role === 'approver'
            ? eq(parseTerms(t.terms_json).approver, me)
            : applied!.has(t.id),
      )
    }
    const statuses = input.status === undefined ? undefined : new Set<string>(input.status)
    if (
      statuses !== undefined &&
      [...statuses].some((status) => !(TASK_STATUSES as readonly string[]).includes(status))
    ) {
      throw new BoardError('invalid', `status must be among ${TASK_STATUSES.join(', ')}`)
    }
    const out = []
    for (const row of statuses === undefined ? rows.slice(0, limit) : rows.slice(0, LIST_STATUS_SCAN)) {
      const summary = await this.#summary(row, caller)
      if (statuses !== undefined && !statuses.has(summary.chain.status)) continue
      out.push(summary)
      if (out.length >= limit) break
    }
    return out
  }

  async getTask(caller: Caller, input: { taskId: string }) {
    const task = this.#task(input.taskId)
    const { summary, creatorSelection } = await this.#summaryParts(task, caller, true)
    const me = caller.address
    const live = me === undefined ? undefined : this.#liveSelection(task, me)
    const mine =
      me === undefined
        ? undefined
        : {
            application:
              this.#sql.all<ApplicationRow>(
                'SELECT * FROM applications WHERE task_id = ? AND worker = ?',
                task.id,
                me,
              )[0] ?? null,
            selected:
              this.#sql.all<SelectionRow>(
                'SELECT * FROM selections WHERE task_id = ? AND worker = ? AND signature IS NOT NULL',
                task.id,
                me,
              ).length > 0,
            liveSelection: live === undefined ? null : { activateBy: live.activate_by },
          }
    const operations = this.#sql.all<OperationRow>(
      'SELECT kind, status, tx_hash, updated_at FROM operations WHERE task_id = ? ORDER BY created_at',
      task.id,
    )
    /** Candidate-level records the worker declared; the on-chain `JobSubmitted` deliverable is the one that counts. */
    const deliverables = this.#sql
      .all<{
        worker: string
        deliverable_hash: string
        repo: string
        branch: string
        sha: string
        kind: string | null
        descriptor_json: string | null
        check_json: string | null
      }>(
        'SELECT worker, deliverable_hash, repo, branch, sha, kind, descriptor_json, check_json FROM deliverables WHERE task_id = ? ORDER BY created_at',
        task.id,
      )
      .map(deliverableView)
    const onchain =
      this.#sql.all<{ deliverable_hash: string; tx_hash: string }>(
        'SELECT deliverable_hash, tx_hash FROM onchain_submissions WHERE task_id = ?',
        task.id,
      )[0] ?? null
    return {
      ...summary,
      terms: JSON.parse(task.terms_json) as unknown,
      mine,
      ...(creatorSelection === undefined ? {} : { selection: creatorSelection }),
      deliverables,
      onchainSubmission: onchain,
      evidence: this.#evidence(task),
      operations,
    }
  }

  async #selectionView(task: TaskRow, view: ChainView, deliveryDeadline: number) {
    return await creatorSelectionProjection(
      this.#sql.all<SelectionRow & { application_worker: string | null; application_agent_id: string | null }>(
        `SELECT s.*, a.worker AS application_worker, a.agent_id AS application_agent_id
             FROM selections AS s LEFT JOIN applications AS a ON a.id = s.application_id AND a.task_id = s.task_id
             WHERE s.task_id = ? ORDER BY s.created_at DESC`,
        task.id,
      ),
      view,
      this.#now(),
      deliveryDeadline,
      async (selection) => {
        const ctx = this.#taskCtx(task)
        const [used, wallet, valid] = await Promise.all([
          ctx.publicClient.readContract({
            address: ctx.stack.holding,
            abi: sidequest.holdingAbi(ctx),
            functionName: 'selectionNonceUsed',
            args: [getAddress(task.creator), BigInt(selection.nonce)],
          }),
          sdk.agentWallet(ctx, BigInt(selection.agent_id)),
          ctx.publicClient.verifyTypedData({
            address: getAddress(task.creator),
            domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
            types: sdk.selectionTypes,
            primaryType: 'Selection',
            message: {
              jobId: BigInt(task.job_id as string),
              worker: getAddress(selection.worker),
              agentId: BigInt(selection.agent_id),
              termsHash: task.terms_hash as Hex,
              activateBy: selection.activate_by,
              nonce: BigInt(selection.nonce),
            },
            signature: selection.signature as Hex,
          }),
        ])
        return !used && eq(wallet, selection.worker) && valid
      },
    )
  }

  async #summary(task: TaskRow, caller: Caller) {
    return (await this.#summaryParts(task, caller, false)).summary
  }

  /**
   * Who acts next. While a hire is open with a signed, unexpired selection, the selected worker activates: the creator
   * learns it from the verified selection view, the worker from its own live selection (no chain read).
   */
  #openNextAction(
    task: TaskRow,
    view: ChainView,
    caller: Caller,
    creatorSelection: Awaited<ReturnType<typeof creatorSelectionProjection>> | undefined,
  ): NextAction | null {
    if (view.status === 'open') {
      const signed = creatorSelection?.find((selection) => selection.state === 'signed')
      if (signed !== undefined) return { actor: 'worker', action: 'activate', deadline: signed.activateBy }
      const live =
        creatorSelection === undefined && caller.address !== undefined
          ? this.#liveSelection(task, caller.address)
          : undefined
      if (live !== undefined) return { actor: 'worker', action: 'activate', deadline: live.activate_by }
    }
    return publisherNextAction(view, this.#now())
  }

  /** The task summary, plus the creator's selection view when the caller acts for the creator (read once). */
  async #summaryParts(task: TaskRow, caller: Caller, alwaysSelection: boolean) {
    const terms = parseTerms(task.terms_json)
    const view = await this.#chainView(task)
    const operation =
      this.#sql.all<{ status: string }>(
        'SELECT status FROM operations WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1',
        task.id,
      )[0]?.status ?? null
    const quoteCount =
      this.#sql.all<{ count: number }>(
        'SELECT count(*) AS count FROM quotes q JOIN quote_requests r ON r.id=q.request_id WHERE r.task_id = ?',
        task.id,
      )[0]?.count ?? 0
    const creatorSelection =
      (alwaysSelection || view.status === 'open') &&
      caller.address !== undefined &&
      this.#actsForCreator(task, caller.address)
        ? await this.#selectionView(task, view, terms.deliveryDeadline)
        : undefined
    const nextAction = this.#openNextAction(task, view, caller, creatorSelection)
    const summary = {
      taskId: task.id,
      title: terms.title,
      mode: terms.mode,
      stack: task.stack,
      kind: this.#taskCtx(task).stack.kind,
      token: terms.token,
      reward: terms.reward.toString(),
      creatorBond: terms.creatorBond.toString(),
      workerBond: terms.workerBond.toString(),
      creator: terms.creator,
      approver: terms.approver,
      arbitrator: terms.arbitrator ?? null,
      windows: terms.windows,
      deliveryDeadline: terms.deliveryDeadline,
      termsHash: task.terms_hash,
      manifestUrl: `${this.#config.manifestBaseUrl}/${task.terms_hash}.json`,
      deliverable: specOf(terms),
      executionBudget:
        terms.executionBudget === undefined
          ? null
          : {
              ...(terms.executionBudget.kind === 'call'
                ? {
                    kind: 'call',
                    target: terms.executionBudget.target,
                    function: terms.executionBudget.function,
                    amount: formatUnits(terms.executionBudget.cap, 18),
                    symbol: nativeSymbol(this.#taskCtx(task)),
                  }
                : {
                    kind: 'advance',
                    ...(await this.#displayAmount(this.#taskCtx(task), {
                      token: terms.executionBudget.token,
                      amount: terms.executionBudget.cap.toString(),
                    })),
                  }),
              expiresAt: terms.executionBudget.expiresAt,
              /** promised: in the terms, not granted yet; live: the worker can draw; revoked / ended. */
              grant: this.#budget.grantStatus(task.id),
            },
      jobId: task.job_id,
      screening:
        task.screening_json === null
          ? { verdict: 'unscreened', reasons: [] }
          : (JSON.parse(task.screening_json) as unknown),
      chain: { ...view, paused: await this.#paused(this.#taskCtx(task)) },
      quotesCount: quoteCount,
      nextAction,
      funding: publisherFunding(view),
      operationStatus: operation,
      you:
        caller.address === undefined
          ? null
          : (() => {
              const roles = this.#roles(terms, view, caller.address)
              if (this.#actsForCreator(task, caller.address) && !roles.includes('creator')) roles.push('creator')
              return roles
            })(),
    }
    return { summary, creatorSelection }
  }

  #roles(terms: OfferTerms, view: ChainView, me: Address): string[] {
    const roles: string[] = []
    if (eq(terms.creator, me)) roles.push('creator')
    if (eq(terms.approver, me)) roles.push('approver')
    if (eq(view.provider, me)) roles.push('worker')
    return roles
  }

  /**
   * A publish whose confirmation never reached the board (the response was lost, the client crashed before
   * `report_transaction`): the offer's `termsHash` is listed on-chain, so the listing is found among the newest jobs
   * and recorded, and a retry is never needed (a second publish of the same terms would revert on `PolicyHashUsed`).
   */
  async #recoverPublish(task: TaskRow): Promise<string | null> {
    const ctx = this.#taskCtx(task)
    const listed = await ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: sdk.sidequestHoldingAbi,
      functionName: 'policyListed',
      args: [getAddress(task.creator), task.terms_hash as Hex],
    })
    if (!listed) return null
    const counter = await ctx.publicClient.readContract({
      address: ctx.deployment.core,
      abi: sdk.coreAbi,
      functionName: 'jobCounter',
    })
    for (let id = counter; id > 0n && id > counter - 64n; id--) {
      const listing = await sdk.getListing(ctx, id).catch(() => undefined)
      if (listing === undefined || !eq(listing.policyHash, task.terms_hash) || !eq(listing.creator, task.creator))
        continue
      this.#sql.run('UPDATE tasks SET job_id = ? WHERE id = ? AND job_id IS NULL', id.toString(), task.id)
      this.#sql.run(
        "UPDATE operations SET status = 'confirmed', updated_at = ? WHERE task_id = ? AND kind = 'publish' AND status = 'prepared'",
        this.#now(),
        task.id,
      )
      task.job_id = id.toString()
      return task.job_id
    }
    return null
  }

  /** The task's chain facts, read now. The board's own records never override these. */
  async #chainView(task: TaskRow): Promise<ChainView> {
    const terms = parseTerms(task.terms_json)
    const base: ChainView = {
      status: 'awaiting-publish',
      coreStatus: null,
      listingMatchesOffer: null,
      provider: null,
      submittedAt: null,
      timely: false,
      deliveryDeadline: terms.deliveryDeadline,
      reviewEndsAt: null,
      disputeEndsAt: null,
      arbitrationEndsAt: null,
      violation: null,
    }
    if (task.job_id === null && (await this.#recoverPublish(task)) === null) return base
    return (await sidequest.sidequestChainView(
      this.#taskCtx(task),
      BigInt(task.job_id as string),
      terms,
      task.terms_hash as Hex,
      this.#now(),
    )) as ChainView
  }
}

export const TASK_STATUSES = [
  'awaiting-publish',
  'open',
  'lapsed',
  'active',
  'submitted',
  'rejected-pending',
  'disputed',
  'completed',
  'rejected',
  'cancelled',
  'expired',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** list_tasks roles: creator owns the offer; worker is any application; invited is a direct invite or a picked quote. */
export const TASK_ROLES = ['creator', 'approver', 'worker', 'invited'] as const
export type TaskRole = (typeof TASK_ROLES)[number]

/** The most tasks a status filter reads chain views for in one list_tasks call. */
const LIST_STATUS_SCAN = 40

export interface ChainView {
  status: TaskStatus
  coreStatus: sdk.JobStatusName | null
  listingMatchesOffer: boolean | null
  provider: Address | null
  submittedAt: number | null
  timely: boolean
  deliveryDeadline: number
  reviewEndsAt: number | null
  disputeEndsAt: number | null
  arbitrationEndsAt: number | null
  violation: string | null
  outcome?: string
  deferredDecision?: boolean
  collectPending?: boolean
  feeBps?: number
  fee?: string
  net?: string
  bonus?: string
  paused?: boolean
}
