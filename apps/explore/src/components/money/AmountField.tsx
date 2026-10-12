/**
 * An amount and the token it is in, as one field: a label, a large figure, the token's mark, and what the wallet holds
 * with a Max. Every form that moves money uses it, so an amount always reads and behaves the same way. A computed side
 * (a quote) is the same field, typed in to switch which side leads.
 */
import { type ReactNode, useId } from 'react'
import { zeroAddress } from 'viem'
import { cn } from '../../lib/cn.ts'
import { TokenIcon } from '../token/TokenIcon.tsx'

const TONE = {
  neutral: 'text-muted-foreground',
  warning: 'text-warning-text',
  destructive: 'text-destructive-text',
} as const

interface AmountFieldProps {
  /** A stable id for the input, where a live script finds it (`#stake-amount`). */
  id?: string | undefined
  label: string
  value: string
  onChange: (value: string) => void
  /** The token's address, for its mark; null for the chain's coin (MON). */
  token: string | null
  symbol: string
  /** What the wallet holds, already formatted; with `onMax`, it fills the field. */
  balance?: string | undefined
  onMax?: (() => void) | undefined
  /** Quick amounts beside the label, such as one posting bond. */
  chips?: ReactNode
  /** One line under the figure: a shortfall, a limit, the floor of a quote. */
  hint?: ReactNode
  tone?: keyof typeof TONE
  placeholder?: string
  disabled?: boolean
  /** A computed side still quoting: dimmed, still editable. */
  pending?: boolean
  className?: string
}

export function AmountField({
  id: given,
  label,
  value,
  onChange,
  token,
  symbol,
  balance,
  onMax,
  chips,
  hint,
  tone = 'neutral',
  placeholder = '0',
  disabled = false,
  pending = false,
  className,
}: AmountFieldProps) {
  const generated = useId()
  const id = given ?? generated
  const hintId = `${id}-hint`
  return (
    <div
      className={cn(
        'grid gap-1 rounded-lg bg-background px-3 pt-2 pb-2.5 ring-1 ring-foreground/10 transition-shadow duration-(--dur-fast)',
        'has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/60',
        tone === 'warning' && 'ring-warning/60',
        tone === 'destructive' && 'ring-destructive/60',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="flex min-h-8 items-center justify-between gap-2 text-ui text-muted-foreground">
        <label htmlFor={id}>{label}</label>
        <span className="flex items-center gap-1.5">
          {chips}
          {balance !== undefined && <Balance balance={balance} onMax={onMax} disabled={disabled} />}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={hint === undefined ? undefined : hintId}
          aria-invalid={tone === 'destructive' || undefined}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-2xl leading-tight font-semibold tracking-tight tabular-nums outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed',
            pending && 'text-muted-foreground',
          )}
        />
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted py-1 pr-2.5 pl-1.5 text-sm font-medium">
          <TokenIcon token={token ?? zeroAddress} className="size-5" />
          {symbol}
        </span>
      </div>
      {hint !== undefined && (
        <p id={hintId} className={cn('text-ui text-pretty', TONE[tone])}>
          {hint}
        </p>
      )}
    </div>
  )
}

/** What the wallet holds, as a Max that fills the field when it can. */
function Balance({
  balance,
  onMax,
  disabled,
}: {
  balance: string
  onMax: (() => void) | undefined
  disabled: boolean
}) {
  if (onMax === undefined) return <span className="tabular-nums">{balance}</span>
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onMax}
      className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 tabular-nums transition-colors duration-(--dur-fast) pointer-coarse:min-h-11 [@media(hover:hover)]:hover:text-foreground"
    >
      <span className="font-medium text-foreground">Max</span> {balance}
    </button>
  )
}
