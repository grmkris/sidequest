/** App-only compositions over the vendored base-nova components. */
import { Check, ChevronRight, CircleAlert, Copy, ExternalLink } from 'lucide-react'
import { type ReactNode, type SelectHTMLAttributes, useEffect, useState } from 'react'
import { explorer } from '../wallet.ts'
import { selectRadio } from './radio.ts'
import { cn } from '../lib/cn.ts'
import { Badge } from './ui/badge.tsx'
import { Button, buttonVariants } from './ui/button.tsx'
import { Item, ItemGroup, ItemContent } from './ui/item.tsx'
import { Skeleton } from './ui/skeleton.tsx'

const FIELD =
  'w-full min-w-0 min-h-9 rounded-md border border-input bg-card px-2.5 py-1 text-base transition-colors duration-(--dur-fast) placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm pointer-coarse:min-h-11'

/** A titled block: a quiet header above a surface, and an optional footnote below it. */
export function Section({
  id,
  title,
  note,
  children,
  className,
  action,
}: {
  /** An anchor other pages link to (`/account#backing`). */
  id?: string
  title?: ReactNode
  note?: ReactNode
  children: ReactNode
  className?: string
  action?: ReactNode
}) {
  return (
    <section id={id} className={cn('grid min-w-0 scroll-mt-20 content-start gap-2', className)}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex min-h-6 items-center justify-between gap-3 px-1">
          {title !== undefined && <h2 className="text-ui font-medium text-muted-foreground">{title}</h2>}
          {action}
        </div>
      )}
      {children}
      {note !== undefined && <p className="px-1 text-ui text-muted-foreground">{note}</p>}
    </section>
  )
}

/**
 * Holds a capsule of pills in reach while the page scrolls, with a soft edge where content passes beneath it: in the
 * app, under the phone's top bar or at the top of a wide screen; on the landing (`landing`), under its header.
 */
export function PillDock({ children, landing = false }: { children: ReactNode; landing?: boolean }) {
  return (
    <div
      className={cn(
        'sticky z-20 -my-2 min-w-0 bg-linear-to-b from-background from-70% to-transparent py-2',
        landing ? 'top-[calc(3.5rem+var(--safe-top))]' : 'top-[calc(3rem+var(--safe-top))] lg:top-0 lg:-mt-4 lg:pt-4',
      )}
    >
      {children}
    </div>
  )
}

/** A label and its value on one row. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <Item className="-mx-4 w-auto min-h-10 items-center justify-between gap-4 px-4 py-2 text-sm first:-mt-2 last:-mb-2 pointer-coarse:min-h-11">
      <span className="min-w-0">
        <span className="text-foreground">{label}</span>
        {hint !== undefined && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <span className="min-w-0 text-right text-muted-foreground [overflow-wrap:anywhere]">{children}</span>
    </Item>
  )
}

/** Copy with visible, announced success or failure; the value stays available when clipboard access is refused. */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string
  label?: string
  className?: string
}) {
  const [status, setStatus] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), status === 'done' ? 1400 : 2200)
    return () => clearTimeout(timer)
  }, [status])
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={status === 'failed' ? `${label} failed` : status === 'done' ? `${label} copied` : label}
        title={status === 'failed' ? 'Copy failed' : status === 'done' ? 'Copied' : label}
        onClick={() => {
          if (navigator.clipboard?.writeText === undefined) {
            setStatus('failed')
            return
          }
          void navigator.clipboard.writeText(value).then(
            () => {
              setStatus('done')
            },
            () => {
              setStatus('failed')
            },
          )
        }}
        className={cn(
          'inline-grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) active:bg-muted pointer-coarse:size-11 [@media(hover:hover)]:hover:bg-muted [@media(hover:hover)]:hover:text-foreground',
          status === 'done' && 'text-success-text',
          status === 'failed' && 'text-destructive-text',
          className,
        )}
      >
        {status === 'done' ? (
          <Check data-icon="inline-start" strokeWidth={2.5} />
        ) : status === 'failed' ? (
          <CircleAlert data-icon="inline-start" />
        ) : (
          <Copy data-icon="inline-start" />
        )}
      </Button>
      {status === 'done' && (
        <span role="status" className="text-xs text-success-text">
          Copied
        </span>
      )}
      {status === 'failed' && (
        <span role="status" className="text-xs text-destructive-text">
          Copy failed
        </span>
      )}
    </span>
  )
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const STAT_SIZE = {
  sm: 'truncate font-medium',
  md: 'text-base leading-tight font-semibold tracking-tight',
  lg: 'text-lg leading-tight font-semibold tracking-tight',
} as const

/** A figure in a `<dl>`: its label, its value in tabular numerals, and an optional line under it. */
export function Stat({
  label,
  value,
  sub,
  size = 'lg',
  className,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  size?: keyof typeof STAT_SIZE
  className?: string
}) {
  return (
    <div className={cn('grid min-w-0 content-start gap-0.5', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 tabular-nums', STAT_SIZE[size])}>{value}</dd>
      {sub !== undefined && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  )
}

/**
 * An address in a quiet row, to copy and open on the explorer: in full where someone sends funds to it, `short` where it
 * only names a contract or a wallet.
 */
export function AddressRow({
  value,
  kind = 'address',
  short = false,
  copyLabel = 'Copy address',
  className,
}: {
  value: string
  kind?: 'address' | 'token'
  short?: boolean
  copyLabel?: string
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-0.5 rounded-lg bg-muted/60 py-1 pr-1 pl-3', className)}>
      <code title={value} className="min-w-0 flex-1 font-mono text-ui [overflow-wrap:anywhere]">
        {short ? shortAddress(value) : value}
      </code>
      <CopyButton value={value} label={copyLabel} />
      <a
        href={explorer(kind, value)}
        target="_blank"
        rel="noreferrer"
        aria-label="Open on the explorer"
        title="Open on the explorer"
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'text-muted-foreground')}
      >
        <ExternalLink aria-hidden />
      </a>
    </div>
  )
}

/** An address: shortened, linked to the explorer, copyable. */
export function Address({ value, you = false }: { value: string | null | undefined; you?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">None</span>
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-0.5 font-mono text-ui">
      <a
        href={explorer('address', value)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-8 items-center text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
      >
        {shortAddress(value)}
      </a>
      {you && (
        <Badge variant="info" className="ml-1 font-sans">
          You
        </Badge>
      )}
      <CopyButton value={value} label="Copy address" />
    </span>
  )
}

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (hash === null || hash === undefined) return null
  return (
    // py-3.5 -my-3.5: a 44 px target that takes no more room in its line.
    <a
      href={explorer('tx', hash)}
      target="_blank"
      rel="noreferrer"
      className="-my-3.5 inline-flex items-center gap-1 py-3.5 font-mono text-ui text-muted-foreground underline decoration-current/30 underline-offset-4 hover:text-foreground"
    >
      {label ?? `${hash.slice(0, 10)}…`}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  )
}

/** A link in running text: it keeps the text colour, so the underline is what says "link". */
export const textLinkClass =
  'text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-(--dur-fast) hover:decoration-foreground'

/** A native <select>: a portalled Base UI menu would sit below a modal <dialog> sheet's top layer. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select data-slot="select" {...props} className={cn(FIELD, 'appearance-auto pr-8', className)}>
      {children}
    </select>
  )
}

/** The segmented control (a radiogroup): base-nova's tabs-list look, iOS semantics. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T
  options: ReadonlyArray<readonly [T, ReactNode]>
  onChange: (v: T) => void
  className?: string
  label?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('flex min-w-0 flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]', className)}
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          tabIndex={value === v ? 0 : -1}
          onClick={() => onChange(v)}
          onKeyDown={(event) =>
            selectRadio(
              event,
              options.findIndex(([option]) => option === v),
              options.length,
              (index) => onChange(options[index]![0]),
            )
          }
          className={cn(
            'min-h-8 min-w-min flex-1 rounded-md px-2.5 py-1 text-ui font-medium break-words transition-[background-color,color,box-shadow] duration-(--dur-fast) pointer-coarse:min-h-11',
            value === v
              ? 'bg-background text-foreground shadow-sm ring-1 ring-foreground/5'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** Rows of placeholder while a list loads, so loading never reads as "empty". */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <ItemGroup role="presentation">
      <output className="sr-only">Loading</output>
      {Array.from({ length: rows }, (_, i) => (
        <Item key={i}>
          <ItemContent className="gap-2 py-1">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

/** The page's title: one size step up, semibold, tight; the sub line carries status and context. */
export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="grid gap-1">
      <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] sm:text-4xl">
        {children}
      </h1>
      {sub !== undefined && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{sub}</div>
      )}
    </header>
  )
}

/**
 * Advanced detail kept out of the main path (0x addresses, 7702, delegation, raw allowance): a native disclosure, so
 * it works without script and tests can find it by its summary text.
 */
export function Details({
  summary,
  children,
  className,
  open,
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
  open?: boolean
}) {
  return (
    <details open={open} className={cn('group/details rounded-xl bg-card shadow-stock', className)}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium select-none pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-(--dur-fast) group-open/details:rotate-90"
        />
        {summary}
      </summary>
      <div className="grid gap-3 px-4 pt-1 pb-4">{children}</div>
    </details>
  )
}
