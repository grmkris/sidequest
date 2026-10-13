import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, type TypedDataDefinition, encodeFunctionData, isHex } from 'viem'
import { Schema } from 'effect'
import { type AaJournal, restoreBuilt, storeBuilt } from './aa-journal.ts'
import { userOpCostCopy } from './aa-mode.ts'
import { reconcileUserOp, userOpCalls, type BrowserAaRpc } from './aa-request.ts'
import { emptyJournal, type OpRecord } from './components/txJournal.ts'
import type { WalletStep } from './components/txOperation.ts'

/** The journal keeps only what reconcile reads: the receipt's bigint gas cost would make the record unserialisable,
 *  so its save after a landed operation failed and the page never reported the action (13 Oct, mainnet). */
const journalReceipt = (receipt: { readonly txHash: Hex; readonly status: 'success' | 'reverted' }) => ({
  txHash: receipt.txHash,
  status: receipt.status,
})

const NATIVE = { payment: 'native' } as const
/** A saved action's gas lane: MON-paid when it says so, USDC (or sponsored) otherwise. */
const lane = (saved: Pick<AaJournal, 'payment'>): 'token' | 'native' =>
  saved.payment === 'native' ? 'native' : 'token'
/** The lane field to carry into the action's next record. */
const paymentOf = (saved: Pick<AaJournal, 'payment'>) => (saved.payment === 'native' ? NATIVE : {})

export interface UserOpView {
  readonly record: OpRecord | null
  readonly built: sdk.BuiltUserOp | null
  readonly pending: boolean
  readonly ready: boolean
}

export interface UserOpDependencies {
  readonly rpc: BrowserAaRpc
  readonly deployment: sdk.Deployment
  readonly sender: Address
  readonly txs: readonly WalletStep[]
  readonly sponsor?: 'faucet' | undefined
  /**
   * The gas lane of a new action: `native` pays in MON with no paymaster. Saved with the action, so its retries and a
   * reload keep the lane it was reviewed in; an action saved without one is USDC-paid.
   */
  readonly payment?: 'token' | 'native' | undefined
  readonly minCallGas?: bigint | undefined
  readonly read: () => Promise<OpRecord | null>
  readonly write: (next: OpRecord) => Promise<void>
  readonly guard: () => Promise<void>
  readonly authorize: () => Promise<sdk.SignedAuthorization | undefined>
  readonly sign: (typedData: TypedDataDefinition, description: string) => Promise<Hex>
  readonly report: (hash: Hex) => Promise<void>
  readonly verify: (hash: Hex) => Promise<void>
  readonly done: (hash: Hex) => void
  readonly changed: (view: UserOpView) => void
  readonly now?: () => number
  readonly pause?: () => Promise<void>
}

/** All money-moving requests go through one persisted action lane. The caller holds its browser locks. */
export class BrowserUserOp {
  #view: UserOpView = { record: null, built: null, pending: false, ready: false }
  #finished = false
  constructor(private readonly deps: UserOpDependencies) {}
  #update(patch: Partial<UserOpView>) {
    this.#view = { ...this.#view, ...patch }
    this.deps.changed(this.#view)
  }
  async #write(record: OpRecord) {
    await this.deps.write(record)
    this.#update({ record })
  }
  /** The saved action's gas lane: what its record says, else what this mount was opened for. */
  get payment(): 'token' | 'native' {
    const saved = this.#view.record?.aa
    if (saved != null) return lane(saved)
    return this.deps.payment === 'native' ? 'native' : 'token'
  }
  async #retryable(record: OpRecord, outcome: 'refused' | 'dropped') {
    const aa = record.aa!
    const retry = {
      actionId: aa.actionId,
      ...paymentOf(aa),
      outcome,
      ...(aa.block === undefined ? {} : { block: aa.block }),
    }
    await this.#write({ ...record, aa: retry })
    this.#update({ built: null, pending: false })
  }
  async load() {
    const previous = await this.deps.read()
    const saved = previous ?? { ...emptyJournal(), batch: true }
    if (saved.aa == null) {
      if (saved.pending !== null || saved.hashes.some((hash) => hash !== null) || saved.sponsor != null)
        throw new Error('Reconcile the previous wallet transaction first.')
      saved.aa = { actionId: crypto.randomUUID(), ...(this.deps.payment === 'native' ? NATIVE : {}) }
    }
    await this.#write(saved)
    await this.reconcile()
    this.#update({ ready: true })
  }
  async #record() {
    const record = await this.deps.read()
    if (record?.aa == null) throw new Error('The action journal is unavailable. Nothing may be sent.')
    this.#update({ record })
    return record
  }
  async #finish(record: OpRecord) {
    const receipt = record.aa?.receipt
    if (receipt === undefined) return
    if (receipt.status === 'reverted')
      throw new Error('The user operation reverted. Gas was charged; none of these steps ran.')
    await this.deps.verify(receipt.txHash)
    if (record.recorded[0] !== true) await this.deps.report(receipt.txHash)
    await this.#write({ ...record, hashes: [receipt.txHash], recorded: [true] })
    this.#update({ pending: false })
    if (!this.#finished) {
      this.#finished = true
      this.deps.done(receipt.txHash)
    }
  }
  async reconcile() {
    const record = await this.#record()
    const aa = record.aa!
    if (aa.built === undefined) return 'unbuilt'
    const built = restoreBuilt(aa)
    this.#validate(built, lane(aa))
    this.#update({ built, ready: true })
    if (aa.receipt !== undefined) {
      this.#update({ pending: true })
      await this.#finish(record)
      return 'receipt'
    }
    const outcome = await reconcileUserOp(this.deps.rpc, built, aa, this.#now())
    this.#update({ pending: outcome.at !== 'dropped' })
    if (outcome.at === 'dropped') {
      await this.#retryable(record, 'dropped')
      return outcome.at
    }
    if (outcome.at === 'receipt') {
      const next = { ...record, aa: { ...aa, receipt: journalReceipt(outcome.receipt) } }
      await this.#write(next)
      await this.#finish(next)
    }
    if (outcome.at === 'unknown') {
      if (outcome.spent === true) await this.#write({ ...record, aa: { ...aa, spent: true } })
      throw new Error('The action lane was used but its receipt is unavailable. Reconcile before sending again.')
    }
    return outcome.at
  }
  #validate(built: sdk.BuiltUserOp, payment: 'token' | 'native') {
    const { deployment, sender } = this.deps
    const aa = deployment.aa
    if (aa === null) throw new Error('The saved operation has no readable gas configuration or calls.')
    if (
      built.op.sender.toLowerCase() !== sender.toLowerCase() ||
      built.chainId !== deployment.chainId ||
      built.entryPoint.toLowerCase() !== aa.entryPoint.toLowerCase() ||
      !(payment === 'native' ? this.#nativeAllowed(built, aa) : this.#tokenAllowed(built, aa)) ||
      !this.#callsAllowed(built, aa, payment)
    )
      throw new Error(
        'The saved operation differs from the reviewed wallet, network, calls or gas limit. Reconcile before continuing.',
      )
  }
  /** The reviewed calls, and only on the USDC lane the standing paymaster approval after them. */
  #callsAllowed(built: sdk.BuiltUserOp, aa: sdk.AccountAbstraction, payment: 'token' | 'native'): boolean {
    const expected = userOpCalls(this.deps.txs, this.deps.deployment.chainId)
    const actual = sdk.decodeExecuteCalldata(built.op.callData)
    if (actual === null) throw new Error('The saved operation has no readable gas configuration or calls.')
    const approval =
      payment === 'token' && this.deps.sponsor === undefined && aa.paymaster !== null
        ? [sdk.approveCall(aa.gasToken, aa.paymaster, aa.standingApproval)]
        : []
    const allowed = expected.concat(actual.length === expected.length ? [] : approval)
    return (
      (actual.length === expected.length || actual.length === expected.length + approval.length) &&
      sdk.executeCalldata(allowed).toLowerCase() === built.op.callData.toLowerCase()
    )
  }
  /** A MON-paid operation: no paymaster, no sponsorship, within the network's wei ceiling. */
  #nativeAllowed(built: sdk.BuiltUserOp, aa: sdk.AccountAbstraction): boolean {
    return (
      this.deps.sponsor === undefined &&
      built.op.paymaster === undefined &&
      aa.maxNativeCostPerOp !== null &&
      built.maxCost <= aa.maxNativeCostPerOp
    )
  }
  #tokenAllowed(built: sdk.BuiltUserOp, aa: sdk.AccountAbstraction): boolean {
    return built.op.paymaster !== undefined && built.maxCost <= aa.maxCostPerOp && this.#paymasterAllowed(built)
  }
  #paymasterAllowed(built: sdk.BuiltUserOp): boolean {
    if (this.deps.sponsor !== 'faucet')
      return built.op.paymaster?.toLowerCase() === this.deps.deployment.aa?.paymaster?.toLowerCase()
    const { deployment, txs, sender } = this.deps
    const faucet = deployment.testnetFaucet
    if (
      deployment.chainId !== 10143 ||
      faucet === null ||
      txs.length !== 1 ||
      built.maxCost !== 0n ||
      built.op.paymaster === undefined
    )
      return false
    const claim = sdk.testnetFaucetAbi
    return (
      txs[0]!.to.toLowerCase() === faucet.toLowerCase() &&
      txs[0]!.data.toLowerCase() ===
        encodeFunctionData({ abi: claim, functionName: 'drip', args: [sender] }).toLowerCase()
    )
  }
  async prepare() {
    await this.deps.guard()
    let record = await this.#record()
    if (record.aa!.built !== undefined) {
      if ((await this.reconcile()) !== 'dropped') return
      record = await this.#record()
    }
    const { deployment, rpc, sender } = this.deps
    const payment = lane(record.aa!)
    if (deployment.aa === null)
      throw new Error(`${payment === 'native' ? 'MON' : 'USDC'} gas is unavailable on this network.`)
    const code = Schema.decodeUnknownSync(Schema.String)(await rpc.node('eth_getCode', [sender, 'latest']))
    const delegated = code.toLowerCase() === `0xef0100${deployment.delegation.delegator.slice(2).toLowerCase()}`
    const authorization = delegated ? undefined : await this.deps.authorize()
    if (!delegated && authorization === undefined)
      throw new Error(
        payment === 'native'
          ? 'This wallet cannot authorize its one-time upgrade, so it cannot pay this gas in MON. Nothing was sent.'
          : 'This wallet cannot authorize USDC gas. Fund MON to send it from your wallet.',
      )
    if (
      authorization !== undefined &&
      (authorization.chainId !== deployment.chainId ||
        authorization.address.toLowerCase() !== deployment.delegation.delegator.toLowerCase())
    )
      throw new Error('The wallet authorization uses another network or account implementation.')
    const built = await sdk.buildUserOp({
      aa: deployment.aa,
      chainId: deployment.chainId,
      ...rpc,
      sender,
      calls: () => userOpCalls(this.deps.txs, deployment.chainId),
      nonceKey: sdk.nonceKey(record.aa!.actionId),
      authorization,
      sponsor: this.deps.sponsor,
      minCallGas: this.deps.minCallGas,
      payment,
    })
    await this.deps.guard()
    this.#validate(built, payment)
    this.#update({ built })
  }
  #now() {
    return this.deps.now?.() ?? Date.now()
  }
  async #signed(record: OpRecord): Promise<sdk.BuiltUserOp> {
    if (record.aa!.built !== undefined) return restoreBuilt(record.aa!)
    const built = this.#view.built
    if (built === null) throw new Error('Review the gas cost first.')
    const gas = this.deps.sponsor === 'faucet' ? 'Testnet faucet gas is covered; no MON needed' : userOpCostCopy(built)
    const description = `${this.deps.txs.map((tx) => tx.description).join('; ')}. ${gas}.`
    const signature = await this.deps.sign(
      sdk.delegatorTypedData(built.op, built.chainId, built.entryPoint),
      description,
    )
    return { ...built, op: { ...built.op, signature } }
  }
  async send() {
    await this.deps.guard()
    let record = await this.#record()
    if (record.aa!.built !== undefined) {
      if ((await this.reconcile()) !== 'dropped') return
      record = await this.#record()
    }
    const built = await this.#signed(record)
    this.#validate(built, lane(record.aa!))
    await this.deps.guard()
    const block =
      record.aa!.block ??
      Schema.decodeUnknownSync(
        Schema.String.pipe(Schema.refine((value): value is Hex => isHex(value, { strict: true }))),
      )(await this.deps.rpc.node('eth_blockNumber', []))
    const next: OpRecord = {
      ...record,
      batch: true,
      from: built.op.sender,
      aa: {
        actionId: record.aa!.actionId,
        ...paymentOf(record.aa!),
        built: storeBuilt(built),
        submittedAt: this.#now(),
        block,
      },
    }
    await this.#write(next)
    this.#update({ built, pending: true })
    try {
      await sdk.sendUserOp(this.deps.rpc.bundler, built, built.op.signature)
    } catch (error) {
      if (error instanceof sdk.AaError && error.code === 'refused') {
        const current = await this.#record()
        await this.#retryable(current, 'refused')
        throw new Error('Gas prices moved before it went out; review and confirm again.', { cause: error })
      }
      throw error
    }
    await this.#poll()
  }
  async #poll() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const record = await this.#record()
      const receipt = await sdk.userOpReceipt(this.deps.rpc.bundler, record.aa!.built!.userOpHash)
      if (receipt !== null) {
        const next = { ...record, aa: { ...record.aa!, receipt: journalReceipt(receipt) } }
        await this.#write(next)
        await this.#finish(next)
        return
      }
      if (this.deps.pause !== undefined) await this.deps.pause()
      else await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}
