/**
 * The SIDE trade card's details under its amounts: the rate and price impact of this trade, the least it returns, and
 * the slippage behind that floor, chosen in a small popover (14 Oct: the inline 1/3/5% row wrapped onto its own line
 * on phones and read as a second control group).
 */
import { ChevronDown } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatAmount } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import {
  DEFAULT_SLIPPAGE,
  IMPACT_HIGH,
  IMPACT_WARN,
  SLIPPAGES,
  type Slippage,
  impactText,
  monPerMillion,
  slippageText,
} from '../../side-sheet.ts'
import { chain } from '../../wallet.ts'
import { Segmented } from '../kit.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx'

const MON = chain.nativeCurrency.symbol

/**
 * Under the amounts: this trade's rate and price impact (a warning from 5%, a sentence from 15%), the least it returns,
 * and the slippage behind that floor.
 */
export function TradeDetails({
  trade,
  amounts,
  impact,
  slippage,
  onSlippage,
}: {
  trade: 'buy' | 'sell'
  amounts: { amountIn: bigint; expectedOut: bigint; minOut: bigint } | null
  impact: number | null
  slippage: Slippage
  onSlippage: (next: Slippage) => void
}) {
  const what = trade === 'buy' ? 'buy' : 'sale'
  return (
    <div className="grid gap-1 px-1 text-ui text-muted-foreground tabular-nums">
      {amounts !== null && (
        <div className="flex flex-wrap justify-between gap-x-3">
          <span>
            1M SIDE ≈ {formatAmount(monPerMillion(trade, amounts), 18)} {MON}
          </span>
          {impact !== null && (
            <span className={cn(impact >= IMPACT_WARN && 'font-medium text-warning-text')}>
              Price impact {impactText(impact)}
            </span>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <span className="min-w-0">
          {amounts === null
            ? `Fills at most ${slippageText(slippage)} under the quote`
            : `You’ll get at least ${formatAmount(amounts.minOut, 18)} ${trade === 'buy' ? 'SIDE' : MON}`}
        </span>
        <SlippagePicker slippage={slippage} onSlippage={onSlippage} />
      </div>
      {impact !== null && impact >= IMPACT_HIGH && (
        <p className="text-pretty text-warning-text">
          This {what} moves the price {impactText(impact)}, so it{' '}
          {trade === 'buy' ? 'costs well above' : 'returns well under'} the current price.
        </p>
      )}
    </div>
  )
}

/** "Slippage 3%": opens the choice of how far under the quote a trade may fill, inside the sheet's dialog. */
function SlippagePicker({ slippage, onSlippage }: { slippage: Slippage; onSlippage: (next: Slippage) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  // A popup portalled to <body> renders under the sheet's modal <dialog>: portal into the dialog.
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined)
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setContainer(trigger.current?.closest('dialog') ?? undefined)
      }}
    >
      <PopoverTrigger
        ref={trigger}
        className="-mr-1.5 inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 font-medium text-foreground outline-none transition-colors duration-(--dur-fast) focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11 [@media(hover:hover)]:hover:bg-muted"
      >
        Slippage {slippageText(slippage)}
        <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent container={container} side="top" align="end" className="w-64">
        <Segmented
          label="Slippage"
          value={String(slippage)}
          options={SLIPPAGES.map((bps) => [String(bps), slippageText(bps)] as const)}
          onChange={(next) => onSlippage(SLIPPAGES.find((bps) => String(bps) === next) ?? DEFAULT_SLIPPAGE)}
          className="w-full"
        />
        <p className="text-ui text-pretty text-muted-foreground">
          If the price moves more than this before the trade is mined, it reverts and only its gas is spent.
        </p>
      </PopoverContent>
    </Popover>
  )
}
