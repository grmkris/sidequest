/**
 * The SIDE trade card's two amounts, "You pay" over "You get", in one well. Either can be typed; the other is the
 * quote. The coin side (MON, or USDC on mainnet) is a choice: "You pay" on Buy, "You get" on Sell, where a USDC sale's
 * amount is the quote of the SIDE sold. On Buy, one posting bond is a chip away.
 */
import type { ReactNode } from 'react'
import { useBondPolicy } from '../../bond-policy.ts'
import { formatAmount } from '../../format.ts'
import { fillText } from '../../side-sheet.ts'
import { USDC_DECIMALS } from '../../side-usdc.ts'
import { chain, deployment } from '../../wallet.ts'
import { AmountField } from '../money/AmountField.tsx'
import { type CoinChoice, TokenPicker } from './TokenPicker.tsx'
import type { useTradeForm } from './useTradeForm.ts'

const MON = chain.nativeCurrency.symbol

type Form = ReturnType<typeof useTradeForm>

/** What the fields show beyond the form: whether trading is open, the wallet's limit, a shortfall, a dollar figure. */
export interface FieldsView {
  readonly open: boolean
  /** The most the wallet can pay, in the paid token's units, for Max; undefined signed out. */
  readonly max: bigint | undefined
  /** Why the amount is too much, or null. */
  readonly short: string | null
  /** The MON side in dollars ("≈ $5.06"), where MON has a price. */
  readonly usd: string | undefined
}

/** The coin side of a trade as a token: MON (null) or the pool's USDC. */
function coinToken(form: Form): { token: string | null; symbol: string; decimals: number } {
  return form.coin === 'usdc' && deployment.nativeSwap !== null
    ? { token: deployment.nativeSwap.quote, symbol: 'USDC', decimals: USDC_DECIMALS }
    : { token: null, symbol: MON, decimals: 18 }
}

export function TradeFields({
  form,
  side,
  view,
  choices,
}: {
  form: Form
  side: `0x${string}` | null
  view: FieldsView
  /** MON or USDC, where the network routes USDC; null keeps the coin fixed at MON. */
  choices: readonly CoinChoice[] | null
}) {
  const buy = form.trade === 'buy'
  const picker = (label: string) =>
    choices === null ? undefined : (
      <TokenPicker value={form.coin} choices={choices} onChange={form.setCoin} label={label} />
    )
  return (
    <div className="grid gap-1.5 rounded-xl bg-muted/60 p-1.5">
      <PayField form={form} side={side} view={view} picker={buy ? picker('Pay with') : undefined} />
      <GetField form={form} side={side} view={view} picker={buy ? undefined : picker('Get')} />
    </div>
  )
}

/** "You pay": typed, or quoted from "You get"; Max and a shortfall for a connected wallet. */
function PayField({
  form,
  side,
  view,
  picker,
}: {
  form: Form
  side: `0x${string}` | null
  view: FieldsView
  picker: ReactNode
}) {
  const buy = form.trade === 'buy'
  const paid = buy ? coinToken(form) : { token: side, symbol: 'SIDE', decimals: 18 }
  const { max, short } = view
  const canMax = max !== undefined && max > 0n
  return (
    <AmountField
      label="You pay"
      value={form.payText}
      onChange={(next) => form.type('pay', next)}
      token={paid.token}
      symbol={paid.symbol}
      tokenSlot={picker}
      balance={max === undefined ? undefined : formatAmount(max, paid.decimals)}
      onMax={canMax ? () => form.type('pay', fillText(max, paid.decimals)) : undefined}
      pending={form.edited === 'get' && form.quoting}
      tone={short === null ? 'neutral' : 'warning'}
      hint={short ?? (buy ? view.usd : undefined)}
      disabled={!view.open}
    />
  )
}

/** "You get": typed, or quoted from "You pay"; read-only on a USDC sale; on Buy, one posting bond a chip away. */
function GetField({
  form,
  side,
  view,
  picker,
}: {
  form: Form
  side: `0x${string}` | null
  view: FieldsView
  picker: ReactNode
}) {
  const bond = useBondPolicy().data?.minimumCreatorBond
  const buy = form.trade === 'buy'
  const got = buy ? { token: side, symbol: 'SIDE' } : coinToken(form)
  const quotedOnly = !buy && form.coin === 'usdc'
  const failed = form.typed !== null && form.quote.isError
  const chip =
    buy && bond !== undefined ? (
      <AmountChip onClick={() => form.type('get', fillText(bond))}>1 bond</AmountChip>
    ) : undefined
  return (
    <AmountField
      label="You get"
      value={form.getText}
      onChange={(next) => form.type('get', next)}
      token={got.token}
      symbol={got.symbol}
      tokenSlot={picker}
      chips={chip}
      pending={form.edited === 'pay' && form.quoting}
      hint={getHint({ failed, quotedOnly, buy, usd: view.usd })}
      tone={failed ? 'destructive' : 'neutral'}
      disabled={!view.open || quotedOnly}
    />
  )
}

/** "You get"'s line: a quote that failed, a USDC sale's read-only amount, or a sale's MON in dollars. */
function getHint(input: { failed: boolean; quotedOnly: boolean; buy: boolean; usd: string | undefined }) {
  if (input.failed) return 'This amount can’t be quoted right now.'
  if (input.quotedOnly) return 'Quoted from the SIDE you sell.'
  return input.buy ? undefined : input.usd
}

/** A quick amount beside a field's label: one posting bond. */
function AmountChip({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-7 items-center rounded-full bg-muted px-2.5 text-xs font-medium text-foreground transition-[background-color,scale] duration-(--dur-fast) active:scale-[0.96] disabled:opacity-50 pointer-coarse:min-h-11 [@media(hover:hover)]:hover:bg-muted/70"
    >
      {children}
    </button>
  )
}
