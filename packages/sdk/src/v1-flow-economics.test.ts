import { erc20Abi } from 'viem'
import {
  type Abi,
  type Address,
  type TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
} from 'viem'
import { expect, it } from 'vitest'
import { coreAbi, sidequestHoldingAbi, stakeVaultAbi } from './abi/index.ts'
import { type JobEconomics, SLASH_SINK, verifyJobEconomics, verifyOwedWithdrawal } from './v1-flow-economics.ts'

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const x: JobEconomics = {
  jobId: 98n,
  holding: addr(1),
  core: addr(2),
  vault: addr(3),
  factory: addr(4),
  token: addr(5),
  creator: addr(6),
  worker: addr(7),
  creatorBond: 10n,
  workerBond: 10n,
  slashCreator: false,
  slashWorker: true,
  workerCredit: 70n,
  workerOwed: 0n,
}
function log(abi: Abi, name: string, address: Address, args: Record<string, unknown>) {
  const event = abi.find((e) => e.type === 'event' && e.name === name)
  if (event?.type !== 'event') throw new Error('missing test event')
  const dataFields = event.inputs.filter((input) => !input.indexed)
  return {
    address,
    topics: encodeEventTopics({ abi, eventName: name, args }),
    data: encodeAbiParameters(
      dataFields,
      dataFields.map((field) => args[field.name!]),
    ),
  }
}
const receipt = (logs: ReturnType<typeof log>[]): TransactionReceipt =>
  ({ status: 'success', transactionHash: `0x${'1'.repeat(64)}`, logs }) as TransactionReceipt
function terminal(owed = false, slashTo: Address = zeroAddress) {
  return receipt([
    log(sidequestHoldingAbi, 'BondReleased', x.holding, { jobId: x.jobId, side: 0, account: x.creator, amount: 10n }),
    log(stakeVaultAbi, 'Released', x.vault, { holding: x.holding, account: x.creator, amount: 10n }),
    log(sidequestHoldingAbi, 'BondSlashed', x.holding, { jobId: x.jobId, side: 1, account: x.worker, amount: 10n }),
    log(stakeVaultAbi, 'Slashed', x.vault, { holding: x.holding, account: x.worker, amount: 10n }),
    log(erc20Abi, 'Transfer', x.factory, { from: x.vault, to: slashTo, value: 10n }),
    ...(owed
      ? [
          log(sidequestHoldingAbi, 'RewardSettled', x.holding, {
            jobId: x.jobId,
            to: x.worker,
            outcome: 1,
            amount: 70n,
          }),
          log(sidequestHoldingAbi, 'PayoutOwed', x.holding, {
            jobId: x.jobId,
            to: x.worker,
            token: x.token,
            amount: 70n,
          }),
        ]
      : [
          log(coreAbi, 'PaymentReleased', x.core, { jobId: x.jobId, recipient: x.worker, amount: 70n }),
          log(erc20Abi, 'Transfer', x.token, { from: x.core, to: x.worker, value: 70n }),
        ]),
  ])
}
it('proves exact per-job release, slash and payment from authentic receipts', () => {
  verifyJobEconomics([terminal()], x)
  verifyJobEconomics([terminal(true)], { ...x, workerOwed: 70n })
})
it('accepts a legacy testnet slash sent to the dead address', () => {
  verifyJobEconomics([terminal(false, SLASH_SINK)], x)
  expect(() => verifyJobEconomics([terminal(false, addr(9))], x)).toThrow()
})
it('accepts a slash to the configured recipient', () => {
  const recipient = addr(9)
  verifyJobEconomics([terminal(false, recipient)], { ...x, slashRecipient: recipient })
})
it('accepts legacy zero and dead-address transfers when a recipient is supplied', () => {
  const withRecipient = { ...x, slashRecipient: addr(9) }
  verifyJobEconomics([terminal()], withRecipient)
  verifyJobEconomics([terminal(false, SLASH_SINK)], withRecipient)
})
it('refuses an arbitrary recipient even when a different recipient is configured', () => {
  expect(() => verifyJobEconomics([terminal(false, addr(8))], { ...x, slashRecipient: addr(9) })).toThrow()
})
it('refuses an extra transfer to an unapproved recipient alongside a valid slash', () => {
  const recipient = addr(9)
  const r = terminal(false, recipient)
  const extra = receipt([log(erc20Abi, 'Transfer', x.factory, { from: x.vault, to: addr(8), value: 1n })])
  expect(() =>
    verifyJobEconomics([{ ...r, logs: [...r.logs, ...extra.logs] }], { ...x, slashRecipient: recipient }),
  ).toThrow('unapproved recipient')
})
it('requires the actual Vault effects and token transfer alongside protocol statements', () => {
  const r = terminal()
  for (let i = 0; i < r.logs.length; i++)
    expect(() => verifyJobEconomics([{ ...r, logs: r.logs.filter((_log, n) => n !== i) }], x)).toThrow()
  expect(() => verifyJobEconomics([{ ...r, status: 'reverted' }], x)).toThrow('successful')
  expect(() => verifyJobEconomics([r, r], x)).toThrow('unique')
  for (const change of [
    { jobId: 99n },
    { holding: addr(8) },
    { vault: addr(8) },
    { factory: addr(8) },
    { token: addr(8) },
    { worker: addr(8) },
    { creator: addr(8) },
    { workerBond: 11n },
    { workerCredit: 71n },
  ])
    expect(() => verifyJobEconomics([r], { ...x, ...change })).toThrow()
})
it('binds owed proof and withdrawal to the exact token/account/contract and amount', () => {
  const r = terminal(true)
  for (const change of [{ token: addr(8) }, { worker: addr(8) }, { workerOwed: 69n }])
    expect(() => verifyJobEconomics([r], { ...x, workerOwed: 70n, ...change })).toThrow()
  const withdrawal = receipt([
    log(sidequestHoldingAbi, 'OwedWithdrawn', x.holding, { to: x.worker, token: x.token, amount: 70n }),
    log(erc20Abi, 'Transfer', x.token, { from: x.holding, to: x.worker, value: 70n }),
  ])
  verifyOwedWithdrawal(withdrawal, x.holding, x.token, x.worker, 70n)
  for (const [holding, token, worker, amount] of [
    [addr(8), x.token, x.worker, 70n],
    [x.holding, addr(8), x.worker, 70n],
    [x.holding, x.token, addr(8), 70n],
    [x.holding, x.token, x.worker, 69n],
  ] as const)
    expect(() => verifyOwedWithdrawal(withdrawal, holding, token, worker, amount)).toThrow()
  expect(() =>
    verifyOwedWithdrawal({ ...withdrawal, logs: withdrawal.logs.slice(0, 1) }, x.holding, x.token, x.worker, 70n),
  ).toThrow('transferred')
})
