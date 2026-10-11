import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  TransactionReceiptNotFoundError,
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  size,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Board, BoardError } from './service.ts'
import { SPONSOR_LIMITS, SponsorDesk, sponsorBudget } from './sponsor.ts'
import { sponsorRelayFloor } from './sponsor-policy.ts'
import { fromNodeSqlite } from './store.ts'
import { delegationManagerAbi } from '@sidequest/sdk'
import { RelaySender } from './relay.ts'
import { admissionFailure, hostedToolNames, parseHostedAdmission, readOnlyHostedTools } from './admission.ts'

const dbs: DatabaseSync[] = []
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
  sdk.setRelayOverride(undefined)
})
const addr = (n: string) => `0x${n.repeat(40)}` as Address
function fixture(network: sdk.Network = 'monad-testnet') {
  const owner = privateKeyToAccount(generatePrivateKey()),
    relay = privateKeyToAccount(generatePrivateKey())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const stack: sdk.Stack = { ...base.stack, kind: 'sidequest-v1', holding: addr('1'), evaluator: addr('2') }
  const deployment = {
    ...base.deployment,
    network,
    chainId: network === 'monad-mainnet' ? 143 : 10143,
    relay: relay.address,
    stacks: { main: stack },
    sidequest: {
      block: 0n,
      factory: stack.factory,
      safe: addr('4'),
      vault: addr('3'),
      feeSchedule: addr('5'),
    },
  }
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const sql = fromNodeSqlite(db)
  let now = 1_800_000_000,
    used = 0n,
    nonce = 0,
    upgraded = true,
    disabled = false,
    visible = true,
    balance = 100n * 10n ** 18n
  const receipts = new Map<string, Record<string, unknown>>()
  const receipt = async ({ hash }: { hash: Hex }) => {
    const found = visible ? receipts.get(hash) : undefined
    if (!found) throw new TransactionReceiptNotFoundError({ hash })
    return found
  }
  const client = {
    ...base.publicClient,
    getCode: vi.fn(async () => (upgraded ? `0xef0100${deployment.delegation.delegator.slice(2)}` : '0x')),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'callCounts' ? used : disabled,
    ),
    getTransactionReceipt: vi.fn(receipt),
    waitForTransactionReceipt: vi.fn(receipt),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(now), baseFeePerGas: 1_000_000_000n })),
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) =>
      !visible && blockTag === 'latest' ? Math.max(0, nonce - 1) : nonce,
    ),
    getBalance: vi.fn(async () => balance),
    estimateGas: vi.fn(async () => 100_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getGasPrice: vi.fn(async () => 2_000_000_000n),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 1_000_000_000n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const hash = keccak256(serializedTransaction)
      const tx = parseTransaction(serializedTransaction)
      if (tx.data === '0x' || tx.data === undefined) {
        expect(sql.all('SELECT * FROM sponsor_replacements WHERE tx_hash=?', hash)[0]).toMatchObject({
          raw_tx: serializedTransaction,
          nonce,
          status: 'pending',
        })
        expect(tx.to?.toLowerCase()).toBe(relay.address.toLowerCase())
        expect(tx.value ?? 0n).toBe(0n)
        expect(tx.nonce).toBe(nonce)
        nonce++
        receipts.set(hash, {
          transactionHash: hash,
          status: 'success',
          blockNumber: 5n,
          gasUsed: 21_000n,
          effectiveGasPrice: 1_000_000_000n,
        })
        return hash
      }
      if (tx.to?.toLowerCase() !== deployment.delegation.manager.toLowerCase()) {
        expect(sql.all('SELECT * FROM relay_operations WHERE tx_hash=?', hash)[0]).toMatchObject({
          raw_tx: serializedTransaction,
          nonce,
          status: 'pending',
        })
        expect(tx.nonce).toBe(nonce)
        nonce++
        receipts.set(hash, {
          transactionHash: hash,
          status: 'success',
          blockNumber: 5n,
          gasUsed: 100_000n,
          effectiveGasPrice: 1_000_000_000n,
        })
        return hash
      }
      // Before any broadcast, both identity and signed bytes must already be durable.
      expect(
        sql.all<{ raw_tx: string; tx_hash: string; status: string; baseline_calls: number }>(
          'SELECT * FROM sponsor_operations WHERE tx_hash=?',
          hash,
        )[0],
      ).toMatchObject({ raw_tx: serializedTransaction, tx_hash: hash, status: 'pending', baseline_calls: Number(used) })
      expect(tx.nonce).toBe(nonce)
      const decoded = decodeFunctionData({ abi: delegationManagerAbi, data: tx.data! })
      if (decoded.functionName !== 'redeemDelegations') throw new Error('not a redemption')
      used += BigInt(decoded.args[0].length)
      nonce++
      receipts.set(hash, {
        transactionHash: hash,
        status: 'success',
        blockNumber: 5n,
        gasUsed: 100_000n,
        effectiveGasPrice: 1_000_000_000n,
      })
      return hash
    }),
  }
  const ctx = { ...base, deployment, stack, publicClient: client } as unknown as sdk.Ctx
  const config = {
    sql,
    ctx,
    relay: { account: relay, rpcUrl: 'http://127.0.0.1:1' },
    now: () => now,
    fail: (code: ConstructorParameters<typeof BoardError>[0], message: string) => new BoardError(code, message),
  }
  const boot = () => new SponsorDesk(config)
  const desk = boot()
  const sign = (typedData: string, account = owner) =>
    sdk.signTypedDataJson(
      {
        account,
        signTypedData: (args: Parameters<typeof account.signTypedData>[0]) => account.signTypedData(args),
      } as never,
      typedData,
    )
  const live = async () => {
    const p = await desk.prepare(owner.address)
    await desk.confirm(owner.address, await sign(p.sign.typedData))
    return p
  }
  const cancel = (n = 1n) => ({
    to: stack.holding,
    data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancelSelection', args: [n] }),
  })
  const entries = (calls: readonly import('./sponsor.ts').SponsorCall[], wallet = owner.address) => {
    const row = sql.all<{ delegation_hash: Hex }>(
      "SELECT delegation_hash FROM grants WHERE delegator=? AND kind='operator' ORDER BY expires_at DESC,rowid DESC LIMIT 1",
      wallet.toLowerCase(),
    )[0]
    const fallback = sql.all<{ delegation_hash: Hex }>(
      "SELECT delegation_hash FROM grants WHERE kind='operator' ORDER BY rowid DESC LIMIT 1",
    )[0]
    return [{ grant: row?.delegation_hash ?? fallback!.delegation_hash, calls }]
  }
  return {
    desk,
    boot,
    db,
    sql,
    ctx,
    owner,
    relay,
    client,
    sign,
    live,
    cancel,
    receipts,
    entries,
    relaySender: () => new RelaySender(sql, ctx, relay, 'http://127.0.0.1:1', () => now),
    setNonce: (n: number) => {
      nonce = n
    },
    setUsed: (n: bigint) => {
      used = n
    },
    setNow: (n: number) => {
      now = n
    },
    advance: (n: number) => {
      now += n
    },
    setVisible: (v: boolean) => {
      visible = v
    },
    setDisabled: () => {
      disabled = true
    },
    setUpgraded: (v: boolean) => {
      upgraded = v
    },
    setBalance: (n: bigint) => {
      balance = n
    },
  }
}

describe('ERC-7710 sponsorship boundaries and recovery', () => {
  it('SDK stage override reaches the SponsorDesk relay check and prepared grant', async () => {
    const f = fixture()
    sdk.setRelayOverride(f.relay.address)
    const ctx = { ...sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1'), publicClient: f.ctx.publicClient }
    const desk = new SponsorDesk({
      sql: f.sql,
      ctx,
      relay: { account: f.relay, rpcUrl: 'http://127.0.0.1:1' },
      now: () => 1800000000,
      fail: (code, message) => new BoardError(code, message),
    })
    const prep = await desk.prepare(f.owner.address)
    expect(JSON.parse(prep.sign.typedData).message.delegate).toBe(f.relay.address.toLowerCase())
    const wrong = new SponsorDesk({
      sql: f.sql,
      ctx: { ...ctx, deployment: { ...ctx.deployment, relay: f.owner.address } },
      relay: { account: f.relay, rpcUrl: 'http://127.0.0.1:1' },
      now: () => 1800000000,
      fail: (code, message) => new BoardError(code, message),
    })
    await expect(wrong.prepare(f.owner.address)).rejects.toThrow('configured sponsorship relay')
  })

  it('prepared permissions read none, can be replaced, and use packed 20-byte targets plus finite D10 caveats', async () => {
    const f = fixture()
    const first = await f.desk.prepare(f.owner.address)
    expect(await f.desk.status(f.owner.address)).toEqual({
      status: 'none',
      typedData: null,
      delegationHash: null,
      callsUsed: 0,
    })
    const second = await f.desk.prepare(f.owner.address)
    expect(second.sign.typedData).not.toBe(first.sign.typedData)
    const x = JSON.parse(second.sign.typedData).message as {
      delegate: string
      authority: string
      caveats: Array<{ enforcer: string; terms: Hex }>
    }
    expect(x.delegate).toBe(f.relay.address)
    expect(x.authority).toBe(`0x${'f'.repeat(64)}`)
    const e = f.ctx.deployment.delegation.enforcers
    for (const enforcer of [e.allowedTargets, e.allowedMethods, e.limitedCalls, e.timestamp])
      expect(x.caveats.filter((c) => c.enforcer === enforcer)).toHaveLength(1)
    expect(size(x.caveats.find((c) => c.enforcer === e.allowedTargets)!.terms)).toBe(100)
    expect(size(x.caveats.find((c) => c.enforcer === e.timestamp)!.terms)).toBe(32)
    await expect(f.desk.confirm(f.owner.address, await f.sign(first.sign.typedData))).rejects.toThrow('signature')
    await f.desk.confirm(f.owner.address, await f.sign(second.sign.typedData))
    expect((await f.desk.status(f.owner.address)).status).toBe('live')
  })
  it('refuses wrong signer, an unupgraded wallet, policy/key mismatch, and unavailable chain state', async () => {
    const f = fixture(),
      p = await f.desk.prepare(f.owner.address)
    await expect(f.desk.confirm(f.owner.address, await f.sign(p.sign.typedData, f.relay))).rejects.toThrow('signature')
    f.setUpgraded(false)
    await expect(f.desk.confirm(f.owner.address, await f.sign(p.sign.typedData))).rejects.toThrow('upgrade')
    f.setUpgraded(true)
    await f.desk.confirm(f.owner.address, await f.sign(p.sign.typedData))
    f.client.readContract.mockRejectedValueOnce(new Error('RPC down'))
    await expect(f.desk.status(f.owner.address)).rejects.toThrow('RPC down')
  })
  it('persists signed bytes before broadcast and reconciles a lost response/restart without another send', async () => {
    const f = fixture()
    await f.live()
    f.setVisible(false)
    const first = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'lost-response')
    expect(first.status).toBe('pending')
    f.setVisible(true)
    const second = await f.boot().submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'lost-response')
    expect(second).toMatchObject({
      operationId: first.operationId,
      txHash: first.txHash,
      status: 'confirmed',
      callsUsed: 1,
    })
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(1)
    expect(await f.boot().operation(f.owner.address, first.operationId)).toEqual(second)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(1)
    await expect(f.desk.operation(f.relay.address, first.operationId)).rejects.toThrow('no sponsorship operation')
  })
  it('key dedupe survives metadata changes and grants; another key permits identical legitimate calls', async () => {
    const f = fixture()
    await f.live()
    const first = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'one')
    expect(
      await f.desk.submit(
        f.owner.address,
        f.entries([{ ...f.cancel(), value: '0', chainId: f.ctx.deployment.chainId }], f.owner.address),
        'one',
      ),
    ).toEqual(first)
    expect(await f.desk.submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'one')).toEqual(first)
    const second = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'two')
    expect(second.operationId).not.toBe(first.operationId)
    expect(second.callsUsed).toBe(2)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
    await f.desk.revoke(f.owner.address)
    await f.live()
    expect((await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'one')).txHash).toBe(
      first.txHash,
    )
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
  })
  it('reconciles an existing key before policy, relay or revoked/exhausted grant refusals', async () => {
    const f = fixture()
    await f.live()
    f.setVisible(false)
    const first = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'lost')
    await f.desk.revoke(f.owner.address)
    f.setVisible(true)
    f.setUsed(100n)
    f.setBalance(0n)
    const withoutRelay = new SponsorDesk({
      sql: f.sql,
      ctx: f.ctx,
      now: () => 1_800_000_000,
      fail: (code, message) => new BoardError(code, message),
    })
    const recovered = await withoutRelay.submit(
      f.owner.address,
      f.entries([{ to: f.owner.address, data: '0x' }], f.owner.address),
      'lost',
    )
    expect(recovered).toMatchObject({
      operationId: first.operationId,
      txHash: first.txHash,
      status: 'confirmed',
      callsUsed: 100,
    })
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(1)
    await expect(
      withoutRelay.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'fresh'),
    ).rejects.toMatchObject({ reason: 'unavailable' })
  })
  it('D15 refuses every omitted mutating method and noncanonical calldata before simulation', async () => {
    const f = fixture()
    await f.live()
    for (const [to, abi, methods] of [
      [f.ctx.stack.holding, sdk.sidequestHoldingAbi, ['publish', 'topUp', 'setDefaultArbitrator']],
      [
        f.ctx.stack.evaluator,
        sdk.sidequestEvaluatorAbi,
        ['rule', 'ruleWithSignature', 'cancelRuling', 'notePause', 'setVerifier'],
      ],
      [
        f.ctx.deployment.sidequest!.vault,
        sdk.stakeVaultAbi,
        ['delegate', 'delegateWithPermit', 'requestUndelegate', 'setHoldingDenied'],
      ],
      [f.ctx.deployment.core, sdk.coreAbi, ['setPayoutReceiver', 'pause', 'upgradeToAndCall']],
    ] as const) {
      for (const name of methods) {
        const fn = abi.find((x) => x.type === 'function' && x.name === name)!
        const data = (await import('viem')).toFunctionSelector(fn as import('viem').AbiFunction)
        await expect(
          f.desk.submit(f.owner.address, f.entries([{ to, data }], f.owner.address), name),
        ).rejects.toMatchObject({ reason: 'policy' })
      }
    }
    await expect(
      f.desk.submit(f.owner.address, f.entries([{ ...f.cancel(), value: '1' }], f.owner.address), 'value'),
    ).rejects.toThrow('zero value')
    await expect(
      f.desk.submit(
        f.owner.address,
        f.entries([{ ...f.cancel(), data: `${f.cancel().data}00` }], f.owner.address),
        'trailing',
      ),
    ).rejects.toThrow('canonical calldata')
    await expect(
      f.desk.submit(f.owner.address, f.entries([{ ...f.cancel(), to: f.owner.address }], f.owner.address), 'target'),
    ).rejects.toMatchObject({ reason: 'policy' })
    expect(f.client.estimateGas).not.toHaveBeenCalled()
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled()
  })
  it('uses estimated gas, a small priority fee and receipt cost, reserving gas times the full max fee', async () => {
    const f = fixture()
    await f.live()
    const calls = [
      {
        to: f.ctx.stack.evaluator,
        data: encodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, functionName: 'retryDeferred', args: [1n] }),
      },
      {
        to: f.ctx.stack.holding,
        data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [1n] }),
      },
    ]
    const op = await f.desk.submit(f.owner.address, f.entries(calls, f.owner.address), 'deferred')
    const raw = f.sql.all<{ raw_tx: Hex; cost: string; reserved_cost: string }>(
      'SELECT * FROM sponsor_operations WHERE id=?',
      op.operationId,
    )[0]!
    const tx = parseTransaction(raw.raw_tx)
    expect(tx.gas).toBe(120_000n)
    expect(tx.maxPriorityFeePerGas).toBeLessThan(await f.client.getGasPrice())
    expect(tx.maxFeePerGas).toBe(2_000_000_000n)
    expect(BigInt(raw.reserved_cost)).toBe(tx.gas! * tx.maxFeePerGas!)
    expect(BigInt(raw.cost)).toBe(100_000n * 1_000_000_000n)
    expect(BigInt(raw.reserved_cost)).toBeGreaterThan(BigInt(raw.cost))
    expect(op.callsUsed).toBe(2)
  })
  it('uses the summed inner gas limits and manager overhead only for an unreliable estimate', async () => {
    const f = fixture()
    await f.live()
    const calls = [
      {
        to: f.ctx.stack.evaluator,
        data: encodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, functionName: 'retryDeferred', args: [1n] }),
      },
      {
        to: f.ctx.stack.holding,
        data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [1n] }),
      },
    ]
    f.client.call.mockRejectedValueOnce(new Error('CoreGasTooLow'))
    const op = await f.desk.submit(f.owner.address, f.entries(calls, f.owner.address), 'fallback')
    const raw = f.sql.all<{ raw_tx: Hex }>('SELECT raw_tx FROM sponsor_operations WHERE id=?', op.operationId)[0]!
    expect(parseTransaction(raw.raw_tx).gas).toBe(sdk.V1_GAS.retryDeferred + sdk.V1_GAS.settle + 100_000n)
  })
  it('relay evidence uses the shared small priority fee and the successful gas estimate', async () => {
    const f = fixture()
    await f
      .relaySender()
      .submit({ key: 'evidence-fees', to: f.ctx.stack.evaluator, data: '0x12345678', gas: '1200000' })
    const raw = f.sql.all<{ raw_tx: Hex }>('SELECT raw_tx FROM relay_operations WHERE id=?', 'evidence-fees')[0]!
    const tx = parseTransaction(raw.raw_tx)
    expect(tx.gas).toBe(120_000n)
    expect(tx.maxPriorityFeePerGas).toBeLessThan(await f.client.getGasPrice())
    expect(tx.maxFeePerGas).toBe(2n * (await f.client.getBlock()).baseFeePerGas)
  })
  it('enforces global cap, balance floor, wallet window, and simulation failure without persisting/broadcasting', async () => {
    const f = fixture()
    await f.live()
    f.setBalance(sponsorRelayFloor(f.ctx.deployment.network))
    await expect(
      f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'floor'),
    ).rejects.toMatchObject({ reason: 'floor', retry: 'same-key', retryAfter: 600 })
    f.setBalance(100n * 10n ** 18n)
    f.client.call.mockRejectedValue(new Error('revert'))
    await expect(
      f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'simulation'),
    ).rejects.toMatchObject({ reason: 'simulation', retry: 'none' })
    f.client.call.mockResolvedValue({ data: '0x' })
    expect(f.sql.all('SELECT * FROM sponsor_operations')).toHaveLength(0)
    const op = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'initial')
    f.sql.run(
      'UPDATE sponsor_operations SET cost=? WHERE id=?',
      sponsorBudget(f.ctx.deployment.network).dailyWei.toString(),
      op.operationId,
    )
    await expect(
      f.desk.submit(f.relay.address, f.entries([f.cancel()], f.relay.address), 'other-wallet'),
    ).rejects.toThrow('belong to this wallet')
    await expect(
      f.desk.submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'cap'),
    ).rejects.toMatchObject({ reason: 'cap', retry: 'same-key', retryAfter: 3600 })
    f.sql.run('UPDATE sponsor_operations SET cost=? WHERE id=?', '1', op.operationId)
    f.sql.run(
      'UPDATE sponsor_operator_usage SET calls=? WHERE operation_id=?',
      sponsorBudget(f.ctx.deployment.network).walletCalls,
      op.operationId,
    )
    await expect(
      f.desk.submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'rate'),
    ).rejects.toMatchObject({ reason: 'rate', retry: 'same-key', retryAfter: 300 })
    f.advance(SPONSOR_LIMITS.walletWindow + 1)
    expect(
      (await f.desk.submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'after-window')).status,
    ).toBe('confirmed')
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
  })
  it('serializes concurrent sends and identical retries; an unresolved receipt blocks another action', async () => {
    const f = fixture()
    await f.live()
    const results = await Promise.all([
      f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'one'),
      f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'one'),
      f.desk.submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'two'),
    ])
    expect(results[0]).toEqual(results[1])
    expect(results[2]?.callsUsed).toBe(2)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
    f.setVisible(false)
    const unresolved = await f.desk.submit(f.owner.address, f.entries([f.cancel(3n)], f.owner.address), 'three')
    expect(unresolved.status).toBe('pending')
    await expect(
      f.desk.submit(f.owner.address, f.entries([f.cancel(4n)], f.owner.address), 'four'),
    ).rejects.toMatchObject({ reason: 'pending' })
    const sends = f.client.sendRawTransaction.mock.calls.length
    expect((await f.desk.operation(f.owner.address, unresolved.operationId)).status).toBe('pending')
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(sends)
  })
  it('a consumed stranded nonce becomes dropped, stays terminal on retry, and releases the shared blocker', async () => {
    const f = fixture()
    await f.live()
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('crash before broadcast'))
    const first = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'stranded')
    expect(first.status).toBe('pending')
    f.client.getTransactionCount.mockResolvedValue(1)
    const dropped = await f.boot().operation(f.owner.address, first.operationId)
    expect(dropped.status).toBe('dropped')
    expect(
      f.sql.all<{ status: string }>('SELECT status FROM sponsor_operations WHERE id=?', first.operationId)[0]!.status,
    ).toBe('dropped')
    const sends = f.client.sendRawTransaction.mock.calls.length
    expect((await f.boot().submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'stranded')).status).toBe(
      'dropped',
    )
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(sends)
    f.client.sendRawTransaction.mockImplementationOnce(async ({ serializedTransaction }) => {
      const hash = keccak256(serializedTransaction)
      f.client.getTransactionReceipt.mockResolvedValueOnce({
        transactionHash: hash,
        status: 'success',
        blockNumber: 5n,
        gasUsed: 100_000n,
        effectiveGasPrice: 1n,
      })
      return hash
    })
    const other = await f.desk.prepare(f.relay.address)
    await f.desk.confirm(f.relay.address, await f.sign(other.sign.typedData, f.relay))
    await expect(
      f.boot().submit(f.relay.address, f.entries([f.cancel(2n)], f.relay.address), 'fresh'),
    ).resolves.toMatchObject({ status: 'pending' })
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(sends + 1)
  })
  it('a fresh key recovers a sponsorship crash between INSERT and broadcast with the exact saved bytes', async () => {
    const f = fixture()
    await f.live()
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('process stopped after insert'))
    const stranded = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'crashed')
    const raw = f.sql.all<{ raw_tx: Hex }>('SELECT raw_tx FROM sponsor_operations WHERE id=?', stranded.operationId)[0]!
      .raw_tx
    expect((await f.boot().submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'new-key')).status).toBe(
      'confirmed',
    )
    expect(f.client.sendRawTransaction.mock.calls.map(([a]) => a.serializedTransaction).slice(0, 2)).toEqual([raw, raw])
    expect((await f.boot().operation(f.owner.address, stranded.operationId)).status).toBe('confirmed')
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(3)
  })
  it('a stranded operation is replaced durably after grant revocation or expiry, releasing both ledgers', async () => {
    for (const revoked of [true, false]) {
      const f = fixture()
      await f.live()
      f.client.sendRawTransaction.mockRejectedValueOnce(new Error('not accepted'))
      const op = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'not-broadcast')
      if (revoked) await f.desk.revoke(f.owner.address)
      else f.advance(SPONSOR_LIMITS.validity)
      const sends = f.client.sendRawTransaction.mock.calls.length
      expect((await f.boot().operation(f.owner.address, op.operationId)).status).toBe('pending')
      expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(sends)
      // A different relay request can recover this sponsorship without its key or expired grant.
      await f.relaySender().submit({ key: 'new-evidence-signature', to: f.ctx.stack.evaluator, data: '0x12345678' })
      expect((await f.boot().operation(f.owner.address, op.operationId)).status).toBe('dropped')
      const saved = f.sql.all<{ raw_tx: Hex; tx_hash: Hex; cost: string; charged_day: number }>(
        'SELECT * FROM sponsor_replacements WHERE operation_id=?',
        op.operationId,
      )[0]!
      const original = f.sql.all<{ raw_tx: Hex }>(
        'SELECT raw_tx FROM sponsor_operations WHERE id=?',
        op.operationId,
      )[0]!
      expect(parseTransaction(saved.raw_tx).nonce).toBe(parseTransaction(original.raw_tx).nonce)
      expect(parseTransaction(saved.raw_tx).maxFeePerGas).toBeGreaterThan(
        parseTransaction(original.raw_tx).maxFeePerGas!,
      )
      expect(parseTransaction(saved.raw_tx).maxPriorityFeePerGas).toBeGreaterThan(
        parseTransaction(original.raw_tx).maxPriorityFeePerGas!,
      )
      expect(parseTransaction(saved.raw_tx).maxPriorityFeePerGas).toBeLessThan(await f.client.getGasPrice())
      expect(BigInt(saved.cost)).toBe(21_000n * 1_000_000_000n)
      expect(saved.charged_day).toBeGreaterThan(0)
      expect(
        f.client.sendRawTransaction.mock.calls.slice(sends).some(([a]) => a.serializedTransaction === original.raw_tx),
      ).toBe(false)
      await f.live()
      expect(
        (await f.boot().submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'fresh-after-recovery'))
          .status,
      ).toBe('confirmed')
    }
  })
  it.each(['sponsor', 'relay'])(
    'replacement recovers under a full cap via %s, charges overshoot once and blocks the next sponsorship',
    async (path) => {
      const f = fixture()
      await f.live()
      const charged = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'charged')
      f.client.sendRawTransaction.mockRejectedValueOnce(new Error('crash before broadcast'))
      const pending = await f.desk.submit(f.owner.address, f.entries([f.cancel(2n)], f.owner.address), 'stranded')
      const original = f.sql.all<{ reserved_cost: string }>(
        'SELECT reserved_cost FROM sponsor_operations WHERE id=?',
        pending.operationId,
      )[0]!
      // The cap fills after reservation; recovery must remain possible and may exceed the old reservation.
      f.sql.run(
        'UPDATE sponsor_operations SET cost=? WHERE id=?',
        sponsorBudget(f.ctx.deployment.network).dailyWei.toString(),
        charged.operationId,
      )
      await f.desk.revoke(f.owner.address)
      f.client.getGasPrice.mockResolvedValue(500_000_000_000n)
      f.client.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n, baseFeePerGas: 499_000_000_000n })
      const send = f.client.sendRawTransaction.getMockImplementation()!
      f.client.sendRawTransaction.mockImplementationOnce(async (a) => {
        const tx = parseTransaction(a.serializedTransaction)
        expect(tx.gas).toBe(100_000n)
        expect(tx.maxFeePerGas).toBe(500_250_000_001n)
        expect(tx.gas! * tx.maxFeePerGas!).toBeGreaterThan(BigInt(original.reserved_cost))
        const hash = await send(a)
        f.receipts.get(hash)!.effectiveGasPrice = 500_000_000_000n
        return hash
      })
      if (path === 'sponsor')
        expect((await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'stranded')).status).toBe(
          'dropped',
        )
      else await f.relaySender().submit({ key: 'new-evidence', to: f.ctx.stack.evaluator, data: '0x12345678' })
      const replacement = f.sql.all<{ cost: string; tx_hash: Hex }>(
        'SELECT cost,tx_hash FROM sponsor_replacements WHERE operation_id=?',
        pending.operationId,
      )[0]!
      expect(replacement.cost).toBe((21_000n * 500_000_000_000n).toString())
      const sends = f.client.sendRawTransaction.mock.calls.length
      await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'stranded')
      expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(sends)
      expect(f.sql.all('SELECT cost FROM sponsor_replacements')).toEqual([{ cost: replacement.cost }])
      await f.live()
      await expect(
        f.boot().submit(f.owner.address, f.entries([f.cancel(3n)], f.owner.address), 'after-recovery'),
      ).rejects.toMatchObject({ reason: 'cap' })
      f.advance(86400)
      await f.live()
      expect(
        (await f.boot().submit(f.owner.address, f.entries([f.cancel(3n)], f.owner.address), 'next-day')).status,
      ).toBe('confirmed')
    },
  )
  it('bounds the replacement fee by the original reservation when the preferred fee exceeds it', async () => {
    const f = fixture()
    await f.live()
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('not sent'))
    const op = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'bounded')
    const reservation = 100_000n * 3_000_000_000n
    f.sql.run('UPDATE sponsor_operations SET reserved_cost=? WHERE id=?', reservation.toString(), op.operationId)
    await f.desk.revoke(f.owner.address)
    f.client.getGasPrice.mockResolvedValue(2_600_000_000n)
    f.client.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n, baseFeePerGas: 1_600_000_000n })
    expect((await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'bounded')).status).toBe('dropped')
    const raw = f.sql.all<{ raw_tx: Hex }>(
      'SELECT raw_tx FROM sponsor_replacements WHERE operation_id=?',
      op.operationId,
    )[0]!.raw_tx
    const tx = parseTransaction(raw)
    expect(tx.maxFeePerGas).toBe(3_000_000_000n)
    expect(tx.gas! * tx.maxFeePerGas!).toBe(reservation)
  })
  it('an old high-tip redemption still bumps both signed fee fields on same-nonce recovery', async () => {
    const f = fixture()
    await f.live()
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('not sent'))
    const op = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'old-fees')
    const original = parseTransaction(
      f.sql.all<{ raw_tx: Hex }>('SELECT raw_tx FROM sponsor_operations WHERE id=?', op.operationId)[0]!.raw_tx,
    )
    const raw = await f.relay.signTransaction({
      type: 'eip1559',
      chainId: 10143,
      nonce: original.nonce!,
      to: original.to,
      data: original.data,
      value: 0n,
      gas: original.gas!,
      maxFeePerGas: 204_000_000_000n,
      maxPriorityFeePerGas: 102_000_000_000n,
    })
    f.sql.run(
      'UPDATE sponsor_operations SET raw_tx=?,tx_hash=?,reserved_cost=? WHERE id=?',
      raw,
      keccak256(raw),
      (original.gas! * 204_000_000_000n).toString(),
      op.operationId,
    )
    f.client.getGasPrice.mockResolvedValue(102_000_000_000n)
    f.client.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n, baseFeePerGas: 100_000_000_000n })
    f.client.estimateMaxPriorityFeePerGas.mockResolvedValue(2_000_000_000n)
    await f.desk.revoke(f.owner.address)
    expect((await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'old-fees')).status).toBe('dropped')
    const replacement = parseTransaction(
      f.sql.all<{ raw_tx: Hex }>('SELECT raw_tx FROM sponsor_replacements WHERE operation_id=?', op.operationId)[0]!
        .raw_tx,
    )
    expect(replacement.nonce).toBe(original.nonce)
    expect(replacement.maxPriorityFeePerGas).toBe(127_500_000_001n)
    expect(replacement.maxFeePerGas).toBe(255_000_000_001n)
  })
  it.each(['monad-testnet', 'monad-mainnet'] as const)(
    'uses the shared %s balance floor for recovery',
    async (network) => {
      const f = fixture(network)
      await f.live()
      f.client.sendRawTransaction.mockRejectedValueOnce(new Error('not sent'))
      await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'floor')
      await f.desk.revoke(f.owner.address)
      const minimum = sponsorRelayFloor(network) + 100_000n * 2_500_000_001n
      f.setBalance(minimum - 1n)
      await expect(f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'floor')).rejects.toThrow(
        'balance floor',
      )
      expect(f.sql.all('SELECT * FROM sponsor_replacements')).toHaveLength(0)
      f.setBalance(minimum)
      expect((await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'floor')).status).toBe('dropped')
    },
  )
  it('records the original receipt when the saved redemption wins the replacement race', async () => {
    const f = fixture()
    await f.live()
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('lost send'))
    const op = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'race')
    await f.desk.revoke(f.owner.address)
    f.client.sendRawTransaction.mockImplementationOnce(async ({ serializedTransaction }) => {
      expect(f.sql.all('SELECT raw_tx FROM sponsor_replacements WHERE operation_id=?', op.operationId)[0]).toEqual({
        raw_tx: serializedTransaction,
      })
      f.setNonce(1)
      f.setUsed(1n)
      f.receipts.set(op.txHash, {
        transactionHash: op.txHash,
        status: 'success',
        blockNumber: 5n,
        gasUsed: 123n,
        effectiveGasPrice: 7n,
      })
      throw new Error('nonce already consumed by original')
    })
    const result = await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'race')
    expect(result).toMatchObject({ status: 'confirmed', callsUsed: 1, txHash: op.txHash })
    expect(f.sql.all('SELECT status,cost FROM sponsor_operations WHERE id=?', op.operationId)[0]).toEqual({
      status: 'confirmed',
      cost: '861',
    })
    expect(f.sql.all('SELECT status,cost FROM sponsor_replacements WHERE operation_id=?', op.operationId)[0]).toEqual({
      status: 'dropped',
      cost: null,
    })
  })
  it('replays a persisted replacement after another crash; the original never rebroadcasts', async () => {
    const f = fixture()
    await f.live()
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('not broadcast'))
    const op = await f.desk.submit(f.owner.address, f.entries([f.cancel()], f.owner.address), 'two-crashes')
    await f.desk.revoke(f.owner.address)
    f.client.sendRawTransaction.mockRejectedValueOnce(new Error('crash after replacement insert'))
    expect((await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'two-crashes')).status).toBe(
      'pending',
    )
    const replacement = f.sql.all<{ raw_tx: Hex }>(
      'SELECT raw_tx FROM sponsor_replacements WHERE operation_id=?',
      op.operationId,
    )[0]!
    expect((await f.boot().submit(f.owner.address, f.entries([], f.owner.address), 'two-crashes')).status).toBe(
      'dropped',
    )
    expect(f.client.sendRawTransaction.mock.calls.slice(1).map(([a]) => a.serializedTransaction)).toEqual([
      replacement.raw_tx,
      replacement.raw_tx,
    ])
    expect(f.sql.all('SELECT * FROM sponsor_replacements')).toHaveLength(1)
  })
  it.each(['success', 'reverted', 'dropped'])(
    'a changed evidence key recovers a relay INSERT crash ending in %s before a new nonce',
    async (status) => {
      const f = fixture(),
        request = { key: 'evidence-old-validUntil-signature', to: f.ctx.stack.evaluator, data: '0x12345678' as Hex }
      f.client.sendRawTransaction.mockRejectedValueOnce(new Error('process died before broadcast'))
      await expect(f.relaySender().submit(request)).rejects.toThrow()
      const saved = f.sql.all<{ raw_tx: Hex; tx_hash: Hex; nonce: number }>(
        'SELECT * FROM relay_operations WHERE id=?',
        request.key,
      )[0]!
      expect(saved.nonce).toBe(0)
      if (status === 'dropped') f.setNonce(1)
      else {
        const send = f.client.sendRawTransaction.getMockImplementation()!
        f.client.sendRawTransaction.mockImplementationOnce(async (a) => {
          expect(a.serializedTransaction).toBe(saved.raw_tx)
          const hash = await send(a)
          f.receipts.get(hash)!.status = status
          return hash
        })
      }
      const fresh = await f
        .relaySender()
        .submit({ ...request, key: 'evidence-new-validUntil-signature', data: '0x87654321' })
      expect(fresh.status).toBe('success')
      expect(f.sql.all('SELECT status FROM relay_operations WHERE id=?', request.key)[0]).toEqual({ status })
      expect(
        f.sql.all('SELECT nonce FROM relay_operations WHERE id=?', 'evidence-new-validUntil-signature')[0],
      ).toEqual({ nonce: 1 })
      expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(status === 'dropped' ? 2 : 3)
    },
  )
  it('chain count/expiry/revocation determine status and revocation remains available during drain', async () => {
    const f = fixture()
    await f.live()
    f.setUsed(100n)
    expect((await f.desk.status(f.owner.address)).status).toBe('used')
    f.setUsed(0n)
    f.advance(SPONSOR_LIMITS.validity)
    expect((await f.desk.status(f.owner.address)).status).toBe('expired')
    f.setDisabled()
    expect((await f.desk.status(f.owner.address)).status).toBe('revoked')
    expect((await f.desk.revoke(f.owner.address)).transactions).toEqual([])
    for (const tool of ['sponsor_status', 'sponsor_operation']) expect(readOnlyHostedTools.has(tool)).toBe(true)
    for (const tool of ['sponsor_prepare', 'sponsor_confirm', 'sponsor_submit']) {
      expect(hostedToolNames.has(tool)).toBe(true)
      expect(readOnlyHostedTools.has(tool)).toBe(false)
      expect(admissionFailure(parseHostedAdmission('1'), 'monad-mainnet', 'public', tool, f.owner.address)).toContain(
        'drain',
      )
    }
    expect(
      admissionFailure(parseHostedAdmission('1'), 'monad-mainnet', 'public', 'sponsor_revoke', f.owner.address),
    ).toBeUndefined()
  })
  it('board sponsorship methods require the signed-in owner, including read-only polling', async () => {
    const f = fixture()
    const board = new Board(f.sql, {
      network: 'monad-testnet',
      contexts: { main: f.ctx },
      domain: 'test.invalid',
      uri: 'https://test.invalid',
      manifestBaseUrl: '',
    })
    expect(() => board.sponsorStatus({}, { wallet: f.owner.address })).toThrow('Sign in')
    expect(() => board.sponsorPrepare({ address: f.relay.address }, { wallet: f.owner.address })).toThrow(
      'authenticated wallet',
    )
  })
})

describe('sponsorship budget by network', () => {
  it('gives testnet room for multi-bot runs and keeps the mainnet launch budget', () => {
    expect(sponsorBudget('monad-testnet')).toEqual({ dailyWei: 50n * 10n ** 18n, walletCalls: 150 })
    expect(sponsorBudget('monad-mainnet')).toEqual({ dailyWei: 10n * 10n ** 18n, walletCalls: 20 })
  })
})
