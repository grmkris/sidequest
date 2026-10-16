import { useQuery } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { agentBalances, type AgentBalances } from '../../agent-api.ts'
import type { ManagedAgent } from '../../api.ts'
import { managedKey } from '../../queries.ts'
import { chain } from '../../wallet.ts'
import { useAuth } from '../Wallet.tsx'
import { useNow } from '../Time.tsx'

const labels = {
  wallet: 'Spendable wallet',
  escrow: 'Active hiring escrow',
  paid: 'Confirmed paid earnings',
  pending: 'Pending worker rewards',
  owed: 'Owed · withdrawable',
}
const quantity = (raw: string | null, decimals: number | null, symbol: string | null) =>
  raw === null
    ? 'Unavailable'
    : decimals === null
      ? `${raw} base units (decimals unavailable)`
      : `${formatUnits(BigInt(raw), decimals)} ${symbol ?? 'tokens'}`

function CurrencyBalances({
  currency,
  stale,
  now,
  maxAge,
}: {
  currency: AgentBalances['currencies'][number]
  stale: boolean
  now: number
  maxAge: number
}) {
  const priced =
    !stale &&
    currency.price.observedAt !== null &&
    now >= currency.price.observedAt &&
    now - currency.price.observedAt <= maxAge
  return (
    <section
      className="grid min-w-0 gap-2 border-t border-border/70 pt-3"
      aria-label={`${currency.symbol ?? 'Token'} balances`}
    >
      <p className="font-medium">
        {currency.symbol ?? 'Token'} · {currency.decimals ?? 'unknown'} decimals
      </p>
      {currency.token !== null && <p className="break-all text-xs text-muted-foreground">{currency.token}</p>}
      <dl className="grid gap-2">
        {Object.entries(labels).map(([kind, label]) => {
          // SAFETY: labels enumerates exactly the amount keys in the authenticated snapshot.
          const raw = currency.amounts[kind as keyof typeof currency.amounts]
          const usd = priced ? currency.usd[kind] : null
          return (
            <div key={kind} className="grid min-w-0 gap-0.5 sm:grid-cols-2 sm:gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words tabular-nums sm:text-right">
                {quantity(raw, currency.decimals, currency.symbol)}
                <span className="block text-xs text-muted-foreground">
                  {usd == null
                    ? 'USD estimate unavailable'
                    : `≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`}
                </span>
              </dd>
            </div>
          )
        })}
      </dl>
      <p className="break-words text-xs text-muted-foreground">
        Price: {currency.price.source ?? 'unavailable'}
        {currency.price.observedAt !== null && ` · ${new Date(currency.price.observedAt * 1000).toISOString()}`}
        {!priced && currency.price.observedAt !== null && ' · unavailable or stale'}
      </p>
    </section>
  )
}

/** A receipt history describes past payments; it never increases the wallet's current spendable balance. */
export function BalanceView({ snapshot, now }: { snapshot: AgentBalances; now: number }) {
  const stale = now - snapshot.observedAt > snapshot.priceMaxAgeSeconds
  return (
    <div className="grid min-w-0 gap-4 text-sm" aria-label="Balance and earnings snapshot">
      <div className="grid min-w-0 gap-1 text-muted-foreground">
        <p className="break-all">Wallet {snapshot.wallet}</p>
        <p>
          {snapshot.network} · Chain {snapshot.chainId} · Block {snapshot.blockNumber}
        </p>
        <p>
          Observed {new Date(snapshot.observedAt * 1000).toISOString()}
          {stale ? ' · stale, refreshing' : ''}
        </p>
        <p>
          {snapshot.index === null
            ? 'Indexed earnings unavailable'
            : `History indexed through block ${snapshot.index.next_block - 1} · ${new Date(snapshot.index.updated_at * 1000).toISOString()}`}
        </p>
      </div>
      {snapshot.currencies.map((currency) => (
        <CurrencyBalances
          key={currency.token ?? 'native'}
          currency={currency}
          stale={stale}
          now={now}
          maxAge={snapshot.priceMaxAgeSeconds}
        />
      ))}

      <p className="text-xs text-muted-foreground">
        Only wallet funds are spendable. Escrow, paid history, pending rewards and owed payouts are separate; they are
        never added to wallet funds. Pending rewards depend on the job outcome. Owed can include refunds.
      </p>
      {snapshot.receipts !== null && snapshot.receipts.length > 0 && (
        <details className="min-w-0">
          <summary className="cursor-pointer">Payment receipts ({snapshot.receipts.length})</summary>
          <ul className="mt-2 grid gap-2 text-xs">
            {snapshot.receipts
              .slice(-20)
              .toReversed()
              .map((receipt, index) => (
                <li key={`${receipt.txHash}:${index}`} className="break-all">
                  {receipt.kind} · {receipt.jobId === null ? 'pooled withdrawal' : `Job #${receipt.jobId}`} ·{' '}
                  {receipt.amount} base units ·{' '}
                  <a
                    href={`${chain.blockExplorers?.default.url}/tx/${receipt.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {receipt.txHash}
                  </a>
                </li>
              ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Latest 20 receipts. Withdrawals mixing refunds and rewards are listed separately without guessed earnings
            allocation.
          </p>
        </details>
      )}
    </div>
  )
}

export function BalanceSummary({ agent }: { agent: ManagedAgent }) {
  const auth = useAuth()
  const now = useNow()
  const query = useQuery({
    queryKey: managedKey('agent-balances', auth.address, auth.signedIn, agent.id),
    queryFn: () => agentBalances(agent.id),
    enabled: auth.signedIn && agent.address !== null,
    refetchInterval: 15_000,
  })
  if (query.isError)
    return (
      <output className="text-sm text-muted-foreground">
        Wallet and earnings snapshot unavailable. Retrying shortly.
      </output>
    )
  if (query.data === undefined)
    return <output className="text-sm text-muted-foreground">Reading wallet and earnings…</output>
  return <BalanceView snapshot={query.data} now={now} />
}
