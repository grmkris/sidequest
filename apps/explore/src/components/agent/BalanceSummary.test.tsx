import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentBalances } from '../../agent-api.ts'
import { BalanceView } from './BalanceSummary.tsx'

const now = 1_800_000_000
const snapshot: AgentBalances = {
  wallet: '0x3333333333333333333333333333333333333333',
  network: 'monad-mainnet',
  chainId: 143,
  observedAt: now,
  blockNumber: '100',
  blockTimestamp: now,
  index: { next_block: 101, updated_at: now },
  priceMaxAgeSeconds: 120,
  currencies: [
    {
      token: null,
      symbol: 'MON',
      decimals: 18,
      wallet: '1500000000000000000',
      owed: '0',
      amounts: {
        wallet: '1500000000000000000',
        owed: '0',
        escrow: '0',
        paid: '2000000000000000000',
        pending: '90000000000000000000',
      },
      price: { perUnit: 2, source: 'Local test pool', observedAt: now, sourceAt: now },
      usd: { wallet: 3, owed: 0, escrow: 0, paid: 4, pending: 180 },
    },
  ],
  receipts: [
    {
      token: 'native',
      amount: '2000000000000000000',
      jobId: '12',
      txHash: `0x${'a'.repeat(64)}`,
      block: 99,
      kind: 'paid',
    },
  ],
}

describe('balance and earnings view', () => {
  it('shows readable quantities, provenance and separate funds without adding pending to the wallet', () => {
    const html = renderToStaticMarkup(<BalanceView snapshot={snapshot} now={now} />)
    expect(html).toContain('1.5 MON')
    expect(html).toContain('90 MON')
    expect(html).toContain('Confirmed paid earnings')
    expect(html).toContain('Pending worker rewards')
    expect(html).toContain('Owed · withdrawable')
    expect(html).toContain('Local test pool')
    expect(html).toContain('Chain 143')
    expect(html).toContain('Job #12')
    expect(html).toContain(snapshot.receipts![0]!.txHash)
    expect(html).not.toContain('91.5 MON')
  })
  it('shows unavailable USD after the quote ages out while keeping quantities', () => {
    const html = renderToStaticMarkup(<BalanceView snapshot={snapshot} now={now + 121} />)
    expect(html).toContain('USD estimate unavailable')
    expect(html).toContain('1.5 MON')
    expect(html).not.toContain('≈ $3.00')
  })
  it('keeps zero funds readable and missing prices visibly unavailable', () => {
    const empty = {
      ...snapshot,
      currencies: [
        {
          ...snapshot.currencies[0]!,
          wallet: '0',
          amounts: { wallet: '0', paid: '0', pending: '0', owed: '0', escrow: '0' },
          price: { perUnit: null, source: null, observedAt: null, sourceAt: null },
          usd: { wallet: null },
        },
      ],
    }
    const html = renderToStaticMarkup(<BalanceView snapshot={empty} now={now} />)
    expect(html).toContain('0 MON')
    expect(html).toContain('USD estimate unavailable')
    expect(html).not.toContain('$0.00')
  })
})

it('keeps stale source USD unavailable even when the API observation is fresh', () => {
  const stale = {
    ...snapshot,
    currencies: snapshot.currencies.map((currency) => ({
      ...currency,
      price: { ...currency.price, observedAt: now, sourceAt: now - 121 },
    })),
  }
  const html = renderToStaticMarkup(<BalanceView snapshot={stale} now={now} />)
  expect(html).toContain('1.5 MON')
  expect(html).toContain('source block')
  expect(html).toContain('USD estimate unavailable')
  expect(html).not.toContain('≈ $3.00')
})
