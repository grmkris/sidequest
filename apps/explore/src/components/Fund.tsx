import { erc20Abi } from 'viem'
import { Button } from './ui/button.tsx'
import { Item, ItemGroup, ItemContent, ItemDescription, ItemActions } from './ui/item.tsx'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Details, Address, CopyButton, Section, textLinkClass } from './kit.tsx'
import { TestnetFaucet } from './TestnetFaucet.tsx'
import { BuyButtons } from './Buy.tsx'
import { Fragment, useState } from 'react'
import { zeroAddress } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { formatNumber, tokenInfo } from '../format.ts'
import { approxUsd } from '../usd.ts'
import { type BalanceRow, useWalletBalances, useWalletTokens } from '../wallet-balances.ts'
import { TokenIcon } from './token/TokenIcon.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'
import { chain, deployment, explorer, isMainnet } from '../wallet.ts'

/**
 * The signed-in Privy wallet's balances and how to fund it: people send MON (gas) and the reward/bond tokens to this
 * address from any wallet they already have. The site never connects that other wallet.
 */
export function FundButton({ address }: { address: `0x${string}` }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((o) => !o)}>
        Fund
      </Button>
      {open && <FundPanel address={address} onClose={() => setOpen(false)} />}
    </div>
  )
}

function FundPanel({ address, onClose }: { address: `0x${string}`; onClose: () => void }) {
  const mon = useBalance({ address, chainId: chain.id, query: { refetchInterval: 10_000 } })
  const tokens = useWalletTokens()
  const balances = useReadContracts({
    contracts: tokens.map(
      (t) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const,
    ),
    query: { refetchInterval: 10_000 },
  })
  const [copied, setCopied] = useState(false)
  return (
    <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Your wallet</span>
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Send {chain.nativeCurrency.symbol} for gas and the tokens you pay with and SIDE for deposits at risk to this
        address on {chain.name}, from any wallet you already have.
      </p>
      <Details summary="Technical details" className="mb-3">
        <div className="flex items-center gap-2">
          <code className="break-all rounded bg-muted px-2 py-1 text-xs">{address}</code>
          <Button
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(address)
              setCopied(true)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Explorer: <Address value={address} />
        </p>
      </Details>
      <ul className="mb-3 flex flex-col gap-1">
        <li className="flex justify-between">
          <span className="inline-flex items-center gap-1.5">
            <TokenIcon token={zeroAddress} />
            {chain.nativeCurrency.symbol}
          </span>
          <span>
            {mon.isError || mon.data === undefined
              ? mon.isPending
                ? '…'
                : 'Unavailable'
              : formatNumber(mon.data.value, 18)}
          </span>
        </li>
        {tokens.map((t, i) => {
          const read = balances.data?.[i]
          const v = !balances.isError && read?.status === 'success' ? (read.result as bigint) : undefined
          const info =
            t.toLowerCase() === deployment.factory.toLowerCase() ? { symbol: 'SIDE', decimals: 18 } : tokenInfo(t)
          return (
            <li key={t} className="flex justify-between">
              <span>{info.symbol}</span>
              <TokenAmount
                value={v}
                token={t}
                static
                text={v === undefined ? (balances.isPending ? '…' : 'Unavailable') : undefined}
                className="tabular-nums"
              />
            </li>
          )
        })}
      </ul>
      {!isMainnet && (
        <p className="text-xs text-muted-foreground">
          Testnet: MON for gas from{' '}
          <a className="underline" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
            faucet.monad.xyz
          </a>
          ; SIDE, mUSD and mEUR from Get test tokens on your Sidequest Account page.
        </p>
      )}
    </div>
  )
}

const WHAT: Record<BalanceRow['role'], string> = { bond: 'For deposits at risk', pay: 'Paid in', gas: 'Gas' }
const shown = (row: { status: BalanceRow['status'] }) =>
  row.status === 'value' ? undefined : row.status === 'loading' ? '…' : 'Unavailable'

/** An amount and, when it has a price, its dollar estimate beneath. */
function Amount({
  token,
  value,
  decimals,
  text,
  usd,
}: {
  token: string | null
  value: bigint | undefined
  decimals: number
  text: string | undefined
  usd: number | undefined
}) {
  return (
    <span className="grid min-w-0 max-w-[60%] justify-items-end gap-0.5 text-right">
      {token === null ? (
        <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
          <TokenIcon token={zeroAddress} />
          {text ?? formatNumber(value!, decimals)}
        </span>
      ) : (
        <TokenAmount
          value={value}
          token={token}
          static
          text={text}
          className="min-w-0 font-medium whitespace-normal [overflow-wrap:anywhere]"
        />
      )}
      {usd !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{approxUsd(usd)}</span>}
    </span>
  )
}

/** The SIDE staked behind wallets and agents; it is managed on Account's Backing tab, one tap away. */
function StakedRow({ value, usd }: { value: bigint; usd: number | undefined }) {
  return (
    <Item render={<Link to="/account" hash="backing" />}>
      <ItemContent className="min-w-0 flex-1">
        SIDE staked
        <ItemDescription className="block text-xs text-muted-foreground">Staked</ItemDescription>
      </ItemContent>
      <Amount token={deployment.factory} value={value} decimals={18} text={undefined} usd={usd} />
      <ItemActions>
        <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  )
}

/**
 * The wallet as a section of Account: the full address to fund, live balances with dollar estimates (`usd.ts`), SIDE
 * staked behind agents once the index answers, and where testnet tokens come from.
 */
export function WalletCard({ address }: { address: `0x${string}` }) {
  const { rows, staked, totalUsd } = useWalletBalances(address)
  return (
    <Section
      id="wallet"
      title="Wallet"
      note={
        isMainnet ? (
          <>
            Send {chain.nativeCurrency.symbol} for gas and the tokens you pay with and SIDE for deposits at risk to this
            address, from any wallet you already have.
          </>
        ) : (
          <>
            Testnet: SIDE, mUSD and mEUR come from Get test tokens, MON from{' '}
            <a className={textLinkClass} href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
              faucet.monad.xyz
            </a>
            . Test tokens have no value.
          </>
        )
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-muted/60 px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-ui">{address}</code>
        <CopyButton value={address} label="Copy address" />
        <a className={textLinkClass} href={explorer('address', address)} target="_blank" rel="noreferrer">
          Explorer
        </a>
      </div>
      <ItemGroup>
        {rows.map((row) => (
          <Fragment key={row.token ?? row.symbol}>
            <Item>
              <ItemContent className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {row.symbol}
                <ItemDescription className="block text-xs text-muted-foreground">{WHAT[row.role]}</ItemDescription>
              </ItemContent>
              <Amount token={row.token} value={row.value} decimals={row.decimals} text={shown(row)} usd={row.usd} />
            </Item>
            {row.role === 'bond' && staked.value !== undefined && <StakedRow value={staked.value} usd={staked.usd} />}
          </Fragment>
        ))}
        {totalUsd !== undefined && (
          <Item>
            <ItemContent className="min-w-0 flex-1">
              Priced total
              <ItemDescription className="block text-xs text-muted-foreground">
                {isMainnet ? 'Tokens without a price are left out' : 'Test value · testnet tokens have no real value'}
              </ItemDescription>
            </ItemContent>
            <span className="font-medium tabular-nums">{approxUsd(totalUsd)}</span>
          </Item>
        )}
      </ItemGroup>
      {/* Getting tokens sits with the balances it fills, as the card's foot. */}
      <div className="grid gap-4 rounded-xl bg-muted/40 p-4">
        <TestnetFaucet address={address} />
        <BuyButtons address={address} />
      </div>
    </Section>
  )
}
