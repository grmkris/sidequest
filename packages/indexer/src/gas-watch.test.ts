import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ARBITER_LAUNCH_MON, ARBITER_MON_FLOOR, ARBITER_LAUNCH_FEE, V1_GAS, deployment } from '@sidequest/sdk'
import { fromNodeSqlite, stmt } from './index.ts'
import { GAS_ALERTS, gasLevel, gasWatches, watchGas } from './gas-watch.ts'
import { migrateTelegram, telegramOwnerWallets } from './telegram.ts'

const testnet = deployment('monad-testnet')
const reader = (balance: bigint, deposit: bigint) => ({
  getBalance: async () => balance,
  readContract: async () => deposit,
})

describe('the gas watch (ADR-0023)', () => {
  it('rates each balance against its own warning and critical levels', () => {
    expect(gasLevel('paymaster', GAS_ALERTS.paymaster.warnWei)).toBe('ok')
    expect(gasLevel('paymaster', GAS_ALERTS.paymaster.warnWei - 1n)).toBe('warning')
    expect(gasLevel('paymaster', GAS_ALERTS.paymaster.criticalWei - 1n)).toBe('critical')
    expect(gasLevel('arbitrator', GAS_ALERTS.arbitrator.criticalWei)).toBe('warning')
  })

  it('warns before losing three 203-gwei rulings of headroom and goes critical below one ruling plus reserve', () => {
    expect(ARBITER_LAUNCH_MON).toBe(1_030_800_000_000_000_000n)
    expect(gasLevel('arbitrator', ARBITER_LAUNCH_MON - 1n)).toBe('warning')
    expect(gasLevel('arbitrator', ARBITER_MON_FLOOR + V1_GAS.evaluator * ARBITER_LAUNCH_FEE - 1n)).toBe('critical')
    expect(gasLevel('arbitrator', ARBITER_LAUNCH_MON)).toBe('ok')
  })

  it("watches our paymaster's EntryPoint deposit only where the paymaster is ours, and the arbitrator always", async () => {
    const watches = gasWatches(testnet, reader(7n, 9n))
    expect(watches.map((watch) => watch.kind)).toEqual(['arbitrator', 'paymaster'])
    expect(await Promise.all(watches.map((watch) => watch.read()))).toEqual([7n, 9n])
    const pimlico = { ...testnet, aa: { ...testnet.aa!, paymasterKind: 'pimlico-erc20' as const } }
    expect(gasWatches(pimlico, reader(7n, 9n)).map((watch) => watch.kind)).toEqual(['arbitrator'])
  })

  it('queues one owner alert per level per hour, and none while the balance is fine', async () => {
    const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
    await migrateTelegram(sql)
    const [owner] = telegramOwnerWallets('monad-testnet')
    await sql.batch([
      stmt(
        'INSERT INTO telegram_links (chat_id, chain_id, wallet, linked_at) VALUES (?, ?, ?, 0)',
        '42',
        testnet.chainId,
        owner!.toLowerCase(),
      ),
    ])
    const [arbitrator, paymaster] = gasWatches(testnet, reader(ARBITER_LAUNCH_MON, 10n ** 17n))
    expect(await watchGas(sql, { network: 'monad-testnet', now: 7200, watch: arbitrator! })).toMatchObject({
      level: 'ok',
      queued: false,
    })
    for (const now of [7200, 7300])
      expect(await watchGas(sql, { network: 'monad-testnet', now, watch: paymaster! })).toMatchObject({
        level: 'critical',
        queued: true,
      })
    const queued = await sql.all<{ text: string }>('SELECT text FROM telegram_outbox')
    expect(queued).toHaveLength(1)
    expect(queued[0]?.text).toContain('paymaster deposit critical')
  })
})
