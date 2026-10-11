import { Link } from '@tanstack/react-router'
import { ChevronUp, ExternalLink } from 'lucide-react'
import { Fragment, type ReactNode, type RefObject, useState } from 'react'
import { type Address, zeroAddress } from 'viem'
import { formatNumber } from '../format.ts'
import { cn } from '../lib/cn.ts'
import { approxUsd } from '../usd.ts'
import { type BalanceRow, useWalletBalances } from '../wallet-balances.ts'
import { deployment, explorer, isMainnet, writesOpen } from '../wallet.ts'
import { CopyButton, textLinkClass } from './kit.tsx'
import { TokenIcon } from './token/TokenIcon.tsx'
import { buttonVariants } from './ui/button.tsx'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover.tsx'
import { Monogram } from './Wallet.tsx'

/**
 * A glance at the wallet from the sidebar's account row, which itself still opens Account: every token Explore knows,
 * SIDE staked behind agents, dollar estimates (`usd.ts`), and Buy and Stake beside SIDE. It opens upward from the row
 * and reads nothing until it is opened.
 */
export function WalletPeek({ address, anchor }: { address: Address; anchor: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Wallet balances"
        title="Wallet balances"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'shrink-0 text-muted-foreground active:scale-95',
        )}
      >
        <ChevronUp
          aria-hidden
          className={cn('size-4 transition-transform duration-(--dur-fast)', open && 'rotate-180')}
        />
      </PopoverTrigger>
      <PopoverContent anchor={anchor} side="top" align="start" sideOffset={6} className="w-80 gap-0 p-0">
        <PopoverTitle className="sr-only">Wallet balances</PopoverTitle>
        <Balances address={address} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

const amountText = (row: { status: BalanceRow['status']; value: bigint | undefined; decimals: number }) =>
  row.status === 'value' ? formatNumber(row.value!, row.decimals) : row.status === 'loading' ? '…' : 'Unavailable'

/** One line: what, how much, and its dollar estimate ("—" when the token has no price). */
function Line({
  label,
  amount,
  usd,
  known,
  nested = false,
}: {
  label: ReactNode
  amount: string
  usd: number | undefined
  known: boolean
  nested?: boolean
}) {
  return (
    <li
      className={cn(
        'grid grid-cols-[1fr_auto_4.5rem] items-center gap-x-3 rounded-md px-1.5 py-1.5',
        nested && 'pt-0 text-muted-foreground',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">{label}</span>
      <span className={cn('text-right tabular-nums', !known && 'text-muted-foreground')}>{amount}</span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {usd !== undefined ? approxUsd(usd) : known ? '—' : ''}
      </span>
    </li>
  )
}

function Balances({ address, close }: { address: Address; close: () => void }) {
  const { rows, staked, totalUsd } = useWalletBalances(address)
  const action = buttonVariants({ variant: 'outline', size: 'xs' })
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <Monogram seed={address} />
        <span className="min-w-0 flex-1 truncate font-mono text-ui">{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
        <CopyButton value={address} label="Copy address" />
        <a
          href={explorer('address', address)}
          target="_blank"
          rel="noreferrer"
          aria-label="Wallet on the explorer"
          title="Wallet on the explorer"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ExternalLink aria-hidden />
        </a>
      </div>

      <ul aria-label="Balances" className="grid p-1.5 text-sm">
        {rows.map((row) => (
          <Fragment key={row.token ?? row.symbol}>
            <Line
              label={
                <>
                  <TokenIcon token={row.token ?? zeroAddress} />
                  <span className="truncate font-medium">{row.symbol}</span>
                </>
              }
              amount={amountText(row)}
              usd={row.usd}
              known={row.status === 'value'}
            />
            {row.role === 'bond' && staked.value !== undefined && (
              <Line
                label={<span className="pl-6">staked</span>}
                amount={formatNumber(staked.value, 18)}
                usd={staked.usd}
                known
                nested
              />
            )}
            {row.role === 'bond' && writesOpen && (
              <li className="flex gap-1.5 px-1.5 pt-0.5 pb-2 pl-8">
                {deployment.market !== null && (
                  <Link to="/account" hash="wallet" onClick={close} className={action}>
                    Buy
                  </Link>
                )}
                <Link to="/account" hash="backing" onClick={close} className={action}>
                  Stake
                </Link>
              </li>
            )}
          </Fragment>
        ))}
      </ul>

      <div className="grid gap-1 border-t px-3 py-2.5">
        {totalUsd !== undefined && (
          <div className="flex items-baseline justify-between gap-3 font-medium">
            <span>Priced total</span>
            <span className="tabular-nums">{approxUsd(totalUsd)}</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {isMainnet ? 'Tokens without a price are left out.' : 'Test value · testnet tokens have no real value.'}
        </p>
        {!isMainnet && deployment.testnetFaucet !== null && (
          <Link to="/account" hash="wallet" onClick={close} className={cn(textLinkClass, 'justify-self-start text-xs')}>
            Get test tokens
          </Link>
        )}
      </div>
    </>
  )
}
