import { cn } from '../lib/cn.ts'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Item, ItemActions } from './ui/item.tsx'

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="grid h-11 w-[51px] shrink-0 place-items-center"
    >
      <span
        aria-hidden
        className={cn(
          'relative h-[31px] w-[51px] rounded-full transition-colors duration-200',
          checked ? 'bg-success-text' : 'bg-accent',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] left-[2px] size-[27px] rounded-full bg-ink-on-color shadow-chip transition-transform duration-200 ease-(--ease-sheet)',
            checked && 'translate-x-5',
          )}
        />
      </span>
    </button>
  )
}

export function KV({ label, children, note }: { label: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <Item className={cn('items-baseline justify-between')}>
      <span className="max-w-[55%] shrink-0">
        <span className="block">{label}</span>
        {note !== undefined && <span className="block text-xs leading-snug text-muted-foreground">{note}</span>}
      </span>
      <ItemActions className="min-w-0 flex-1 flex-col items-end text-right text-muted-foreground [overflow-wrap:anywhere]">
        {children}
      </ItemActions>
    </Item>
  )
}

export function Mark({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'wait' | 'none' }) {
  if (tone === 'wait')
    return (
      <span
        aria-hidden
        className="size-6 shrink-0 animate-spin rounded-full border-[2.5px] border-accent border-t-primary"
      />
    )
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full text-ui font-bold text-background',
        tone === 'ok' && 'bg-success-text',
        tone === 'warn' && 'bg-warning-text',
        tone === 'bad' && 'bg-destructive-text',
        tone === 'none' && 'bg-accent text-muted-foreground',
      )}
    >
      {tone === 'ok' ? <Check className="size-3.5" strokeWidth={3} /> : tone === 'none' ? '–' : '!'}
    </span>
  )
}
