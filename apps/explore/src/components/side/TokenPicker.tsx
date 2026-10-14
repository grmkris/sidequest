/**
 * The SIDE card's MON or USDC: the token pill of "You pay" (Buy) or "You get" (Sell), opening the two choices with what
 * the wallet holds of each. USDC goes through the MON/USDC pool in one batch, so a wallet that can't send one (an
 * injected wallet not upgraded) sees it disabled, with why.
 */
import { Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { Coin } from '../../side-usdc.ts'
import { zeroAddress } from 'viem'
import { TokenPill } from '../money/AmountField.tsx'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx'
import { useDialogContainer } from './TradeDetails.tsx'

export interface CoinChoice {
  readonly coin: Coin
  readonly token: string | null
  readonly symbol: string
  /** What the wallet holds, formatted; undefined signed out. */
  readonly balance: string | undefined
  /** Why this coin can't be chosen; null when it can. */
  readonly refusal: string | null
}

export function TokenPicker({
  value,
  choices,
  onChange,
  label,
}: {
  value: Coin
  choices: readonly CoinChoice[]
  onChange: (next: Coin) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const { trigger, container, find } = useDialogContainer()
  const current = choices.find((c) => c.coin === value) ?? choices[0]!
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) find()
        setOpen(next)
      }}
    >
      <PopoverTrigger
        ref={trigger}
        aria-label={`${label}: ${current.symbol}`}
        className="rounded-full outline-none transition-[scale] duration-(--dur-fast) focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.96]"
      >
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted py-1 pr-2 pl-1.5 text-sm font-medium transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:bg-muted/70">
          <TokenIcon token={current.token ?? zeroAddress} className="size-5" />
          {current.symbol}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </span>
      </PopoverTrigger>
      <PopoverContent container={container} side="bottom" align="end" className="w-72 gap-1 p-1.5">
        {choices.map((c) => (
          <button
            key={c.coin}
            type="button"
            disabled={c.refusal !== null}
            onClick={() => {
              onChange(c.coin)
              setOpen(false)
            }}
            className={cn(
              'grid min-h-11 grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-(--dur-fast) focus-visible:bg-muted disabled:cursor-not-allowed [@media(hover:hover)]:enabled:hover:bg-muted',
            )}
          >
            <TokenPill token={c.token} symbol={c.symbol} className={cn(c.refusal !== null && 'opacity-50')} />
            <span className="justify-self-end text-ui text-muted-foreground tabular-nums">{c.balance ?? ''}</span>
            <Check aria-hidden className={cn('size-4', c.coin === value ? 'text-foreground' : 'invisible')} />
            {c.refusal !== null && (
              <span className="col-span-3 text-ui text-pretty text-muted-foreground">{c.refusal}</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
