import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { BoardLink, type LinkTarget } from '../BoardLink.tsx'
import { CardLink } from '../CardLink.tsx'

/** What a press on the row does: open its job's card (a modified click goes to the job), or follow a link. */
export type RowAction =
  | { kind: 'card'; target: LinkTarget; title: ReactNode; card: ReactNode }
  | { kind: 'link'; target: LinkTarget }

/** Where a row's text starts (its inset and orb), so a card opened from the row lines up with the sentence. */
const TEXT_INSET = 64

/**
 * One row of the activity feed. The whole row is one control, a link stretched under the content, so a press anywhere
 * opens it; the links inside (agents, wallets) sit above it and keep their own targets and cards, cmd-click included.
 * No control is nested in another. While its card is open the row stays lit.
 */
export function StretchedRow({
  label,
  action,
  media,
  children,
  aside,
  thumb,
  fresh = false,
}: {
  /** The control's accessible name. */
  label: string
  action: RowAction
  media: ReactNode
  children: ReactNode
  /** A short note at the row's end (the time ago): a fixed slot, so the pictures before it line up. */
  aside?: ReactNode
  /** A small picture of what the row is about, between its text and its aside. */
  thumb?: ReactNode
  /** Just arrived: tinted for a moment, unless the reader prefers less motion. */
  fresh?: boolean
}) {
  const control =
    'absolute inset-0 rounded-none outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset'
  return (
    <li className="relative before:absolute before:top-0 before:right-0 before:left-16 before:border-t before:border-border/70 first:before:hidden">
      <div
        className={cn(
          'relative transition-colors duration-(--dur-fast) has-[>a[aria-expanded=true]]:bg-muted/40 [@media(hover:hover)]:hover:bg-muted/60',
          fresh && 'motion-safe:animate-[row-fresh_1.4s_var(--ease-out-strong)]',
        )}
      >
        {action.kind === 'card' ? (
          <CardLink
            target={action.target}
            title={action.title}
            card={action.card}
            label={label}
            alignOffset={TEXT_INSET}
            className={control}
          />
        ) : (
          <BoardLink target={action.target} aria-label={label} className={control} />
        )}
        <div className="pointer-events-none relative flex min-w-0 items-start gap-3 px-4 py-3 [&_a]:pointer-events-auto [&_a]:relative [&_a]:z-10">
          <span className="shrink-0">{media}</span>
          <div className="grid min-w-0 flex-1 gap-1">{children}</div>
          {thumb}
          <span className="flex min-w-[4ch] shrink-0 items-start justify-end gap-1.5 text-ui text-muted-foreground">
            {aside}
          </span>
        </div>
      </div>
    </li>
  )
}

/** The list the rows sit in: one card, rows divided by inset hairlines. */
export function RowList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex w-full list-none flex-col overflow-hidden rounded-xl bg-card p-0 text-card-foreground ring-1 ring-foreground/10"
    >
      {children}
    </ul>
  )
}
