import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@sidequest/sdk'
import { type Hex, type TransactionReceipt, TransactionReceiptNotFoundError, encodeFunctionData, keccak256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rulingJournal, type RulingSend } from './ruling-journal.ts'
import { ARBITER_MON_FLOOR, sendFundedRuling } from './runtime.ts'

const homes: string[] = []
afterEach(async () => {
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arbiter-ruling-'))
  homes.push(directory)
  const journal = rulingJournal(directory, sdk.hashText)
  const account = privateKeyToAccount(generatePrivateKey())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const intended: RulingSend = {
    taskId: 'task',
    nonce: '7',
    transaction: {
      chainId: base.deployment.chainId,
      to: base.stack.evaluator,
      value: '0',
      description: 'Ruling',
      data: encodeFunctionData({
        abi: sdk.sidequestEvaluatorAbi,
        functionName: 'ruleWithSignature',
        args: [
          {
            jobId: 42n,
            nonce: 7n,
            forWorker: true,
            slashLoser: false,
            deadline: 2000n,
            reasonHash: sdk.hashText('reason'),
          },
          '0x1234',
        ],
      }),
    },
  }
  let spent = false,
    outcome = 3,
    hash: Hex | undefined,
    balance = ARBITER_MON_FLOOR + 240_000n
  const read = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'rulingNonceUsed' ? spent : { outcome },
  )
  const receipt = (txHash = hash ?? sdk.EMPTY_HASH): TransactionReceipt => ({
    status: 'success',
    transactionHash: txHash,
    blockHash: sdk.EMPTY_HASH,
    blockNumber: 1n,
    from: account.address,
    to: base.stack.evaluator,
    contractAddress: null,
    cumulativeGasUsed: 100_000n,
    effectiveGasPrice: 2n,
    gasUsed: 100_000n,
    logs: [],
    logsBloom: '0x',
    transactionIndex: 0,
    type: 'eip1559',
  })
  const getReceipt = vi.fn(async (): Promise<TransactionReceipt> => {
    throw new TransactionReceiptNotFoundError({ hash: hash ?? sdk.EMPTY_HASH })
  })
  const broadcast = vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
    const persisted = await journal.load('task')
    expect(persisted).toMatchObject({ ...intended, raw: serializedTransaction, hash: keccak256(serializedTransaction) })
    expect(await readFile(`${directory}/${sdk.hashText('task')}.json`, 'utf8')).toContain(serializedTransaction)
    hash = keccak256(serializedTransaction)
    return hash
  })
  const sign = vi.fn(async (request: Parameters<sdk.Wallet['signTransaction']>[0]) => {
    expect(await journal.load('task')).toEqual(intended)
    return account.signTransaction({
      chainId: base.deployment.chainId,
      to: request.to,
      data: request.data,
      value: request.value,
      nonce: request.nonce,
      gas: request.gas,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      type: 'eip1559',
    })
  })
  // SAFETY: these fake clients implement only the methods exercised by the funded sender; signing is real viem.
  const wallet = {
    ...sdk.wallet('monad-testnet', account, 'http://127.0.0.1:1'),
    signTransaction: sign,
  } as sdk.Wallet
  // SAFETY: the read/receipt methods below provide precisely the chain facts used by this unit test.
  const ctx = {
    ...base,
    publicClient: {
      ...base.publicClient,
      getChainId: async () => base.deployment.chainId,
      readContract: read,
      getTransactionReceipt: getReceipt,
      waitForTransactionReceipt: async () => receipt(),
      estimateGas: async () => 100_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getBalance: async () => balance,
      getTransactionCount: async () => 9,
      sendRawTransaction: broadcast,
    },
  } as sdk.Ctx
  return {
    ctx,
    wallet,
    intended,
    journal,
    broadcast,
    sign,
    getReceipt,
    read,
    receipt,
    spent: () => {
      spent = true
    },
    balance: (value: bigint) => {
      balance = value
    },
    cancel: () => {
      outcome = 0
      spent = true
    },
  }
}

describe('funded ruling sends', () => {
  it('persists task/nonce/calldata and signed bytes before broadcasting from the arbitrator key', async () => {
    const f = await fixture()
    const result = await sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)
    expect(result.txHash).toBe((await f.journal.load('task'))?.hash)
    expect(f.sign).toHaveBeenCalledWith(expect.objectContaining({ nonce: 9, gas: 120_000n, maxFeePerGas: 2n }))
    expect(f.broadcast).toHaveBeenCalledOnce()
  })
  it('a spent ruling nonce returns chain state without another send', async () => {
    const f = await fixture()
    f.spent()
    expect(await sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)).toEqual({ txHash: null })
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.broadcast).not.toHaveBeenCalled()
  })
  it('a lost send response reconciles the persisted hash and spent nonce before any retry', async () => {
    const f = await fixture()
    f.broadcast.mockImplementationOnce(async ({ serializedTransaction }) => {
      expect((await f.journal.load('task'))?.raw).toBe(serializedTransaction)
      throw new Error('response lost after acceptance')
    })
    await expect(sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)).rejects.toThrow('send uncertain')
    f.spent()
    f.getReceipt.mockImplementationOnce(async () => f.receipt((await f.journal.load('task'))?.hash))
    expect(await sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)).toEqual({
      txHash: (await f.journal.load('task'))?.hash,
    })
    expect(f.broadcast).toHaveBeenCalledOnce()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('an unlanded retry reuses the same signed bytes and transaction nonce', async () => {
    const f = await fixture()
    f.broadcast.mockRejectedValueOnce(new Error('uncertain'))
    await expect(sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)).rejects.toThrow('uncertain')
    const saved = await f.journal.load('task')
    await sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)
    expect(f.broadcast.mock.calls[1]?.[0].serializedTransaction).toBe(saved?.raw)
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('low MON float refuses without signing or sending', async () => {
    const f = await fixture()
    f.balance(ARBITER_MON_FLOOR + 239_999n)
    await expect(sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)).rejects.toThrow(
      'Fund the arbitrator MON float',
    )
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.broadcast).not.toHaveBeenCalled()
  })
  it('a cancelled nonce and a failed journal write never broadcast', async () => {
    const f = await fixture()
    f.cancel()
    await expect(sendFundedRuling(f.wallet, f.ctx, f.journal, f.intended)).rejects.toThrow('cancelled')
    expect(f.broadcast).not.toHaveBeenCalled()
    const g = await fixture()
    await expect(
      sendFundedRuling(
        g.wallet,
        g.ctx,
        {
          ...g.journal,
          save: async () => {
            throw new Error('disk full')
          },
        },
        g.intended,
      ),
    ).rejects.toThrow('disk full')
    expect(g.broadcast).not.toHaveBeenCalled()
  })
})
