import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, type TypedDataDefinition, encodeFunctionData, isHex } from 'viem'
import { Schema } from 'effect'
import { restoreBuilt, storeBuilt } from './aa-journal.ts'
import { maxCostCopy } from './aa-mode.ts'
import { reconcileUserOp, userOpCalls, type BrowserAaRpc } from './aa-request.ts'
import { emptyJournal, type OpRecord } from './components/txJournal.ts'
import type { WalletStep } from './components/txOperation.ts'

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
  async #retryable(record: OpRecord, outcome: 'refused' | 'dropped') {
    const aa = record.aa!
    const retry = { actionId: aa.actionId, outcome, ...(aa.block === undefined ? {} : { block: aa.block }) }
    await this.#write({ ...record, aa: retry })
    this.#update({ built: null, pending: false })
  }
  async load() {
    const previous = await this.deps.read()
    const saved = previous ?? { ...emptyJournal(), batch: true }
    if (saved.aa == null) {
      if (saved.pending !== null || saved.hashes.some((hash) => hash !== null) || saved.sponsor != null)
        throw new Error('Reconcile the previous wallet transaction first.')
      saved.aa = { actionId: crypto.randomUUID() }
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
    this.#validate(built)
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
      const next = { ...record, aa: { ...aa, receipt: outcome.receipt } }
      await this.#write(next)
      await this.#finish(next)
    }
    if (outcome.at === 'unknown') {
      if (outcome.spent === true) await this.#write({ ...record, aa: { ...aa, spent: true } })
      throw new Error('The action lane was used but its receipt is unavailable. Reconcile before sending again.')
    }
    return outcome.at
  }
  #validate(built: sdk.BuiltUserOp) {
    const { deployment, sender, txs } = this.deps
    const aa = deployment.aa
    const expected = userOpCalls(txs, deployment.chainId)
    const actual = sdk.decodeExecuteCalldata(built.op.callData)
    if (aa === null || actual === null)
      throw new Error('The saved operation has no readable gas configuration or calls.')
    const approval = aa.paymaster === null ? [] : [sdk.approveCall(aa.gasToken, aa.paymaster, aa.standingApproval)]
    const sameCalls =
      actual.length === expected.length || (this.deps.sponsor === undefined && actual.length === expected.length + 1)
    const allowed = expected.concat(actual.length === expected.length ? [] : approval)
    if (
      built.op.sender.toLowerCase() !== sender.toLowerCase() ||
      built.chainId !== deployment.chainId ||
      built.entryPoint.toLowerCase() !== aa.entryPoint.toLowerCase() ||
      !this.#paymasterAllowed(built) ||
      built.maxCost > aa.maxCostPerOp ||
      !sameCalls ||
      sdk.executeCalldata(allowed).toLowerCase() !== built.op.callData.toLowerCase()
    )
      throw new Error(
        'The saved operation differs from the reviewed wallet, network, calls or gas limit. Reconcile before continuing.',
      )
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
    if (deployment.aa === null) throw new Error('USDC gas is unavailable on this network.')
    const code = Schema.decodeUnknownSync(Schema.String)(await rpc.node('eth_getCode', [sender, 'latest']))
    const delegated = code.toLowerCase() === `0xef0100${deployment.delegation.delegator.slice(2).toLowerCase()}`
    const authorization = delegated ? undefined : await this.deps.authorize()
    if (!delegated && authorization === undefined)
      throw new Error('This wallet cannot authorize USDC gas. Fund MON to send it from your wallet.')
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
    })
    await this.deps.guard()
    this.#validate(built)
    this.#update({ built })
  }
  #now() {
    return this.deps.now?.() ?? Date.now()
  }
  async #signed(record: OpRecord): Promise<sdk.BuiltUserOp> {
    if (record.aa!.built !== undefined) return restoreBuilt(record.aa!)
    const built = this.#view.built
    if (built === null) throw new Error('Review the gas cost first.')
    const gas =
      this.deps.sponsor === 'faucet' ? 'Testnet faucet gas is covered; no MON needed' : maxCostCopy(built.maxCost)
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
    this.#validate(built)
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
      aa: { actionId: record.aa!.actionId, built: storeBuilt(built), submittedAt: this.#now(), block },
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
        const next = { ...record, aa: { ...record.aa!, receipt } }
        await this.#write(next)
        await this.#finish(next)
        return
      }
      if (this.deps.pause !== undefined) await this.deps.pause()
      else await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}
