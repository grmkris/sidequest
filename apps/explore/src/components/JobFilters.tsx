import { JOB_TAG_LABELS, JOB_TAGS, type JobTag } from '@sidequest/sdk'
import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import { Button } from './ui/button.tsx'

/**
 * The pieces of a filterable list of work, shared by Activity and the embed's job list: a search box, the tag chips
 * and the notice shown when chain or board reads fail. Each list keeps its filter state in its own URL.
 */
export function SearchBox({
  value,
  onChange,
  label = 'Search jobs',
}: {
  value: string
  onChange: (value: string) => void
  label?: string
}) {
  return (
    <label className="flex min-h-9 items-stretch gap-2 rounded-md border border-input bg-card px-2.5 text-muted-foreground focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring pointer-coarse:min-h-11">
      <Search aria-hidden className="size-4 shrink-0 self-center" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="min-h-9 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none md:text-sm pointer-coarse:min-h-11"
      />
    </label>
  )
}

/** One chip per job tag; a row matches when it carries any chosen tag. */
export function TagChips({ tags, onChange }: { tags: readonly JobTag[]; onChange: (tags: JobTag[]) => void }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend className="float-left mr-1 text-xs font-medium text-muted-foreground">Tags</legend>
      {JOB_TAGS.map((tag) => {
        const on = tags.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? tags.filter((t) => t !== tag) : [...tags, tag])}
            className={cn(
              'min-h-8 rounded-lg px-3 text-sm font-medium transition-[background-color,color,box-shadow] duration-(--dur-fast) pointer-coarse:min-h-11',
              on ? 'bg-card text-foreground shadow-stock' : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            {JOB_TAG_LABELS[tag]}
          </button>
        )
      })}
      {tags.length > 0 && (
        <button
          type="button"
          className="min-h-8 px-2 text-xs text-muted-foreground underline underline-offset-4"
          onClick={() => onChange([])}
        >
          Clear
        </button>
      )}
    </fieldset>
  )
}

const KNOWN_TAGS: ReadonlySet<string> = new Set(JOB_TAGS)

/** Tags from the URL's `tags=a,b`: known tags only, each once. */
export function readTags(value: string | null): JobTag[] {
  return [...new Set((value ?? '').split(',').filter((tag): tag is JobTag => KNOWN_TAGS.has(tag)))]
}

/** What failed to read and what the list still shows; chain facts alone decide payment status. */
export function ReadNotice({
  chainError,
  boardError,
  chainReady,
  chainUpdatedAt,
  onRetry,
}: {
  chainError: unknown
  boardError: unknown
  chainReady: boolean
  chainUpdatedAt: number
  onRetry: () => void
}) {
  if (chainError === null && boardError === null) return null
  return (
    <output className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
      {chainError !== null && (
        <p>
          Chain data is unavailable.
          {chainReady
            ? ` Showing last-known chain facts from ${new Date(chainUpdatedAt).toLocaleString()}; statuses have not been changed.`
            : ' Payment statuses and counts cannot be confirmed.'}
        </p>
      )}
      {boardError !== null && (
        <p>
          Board details are unavailable. Existing chain facts still determine payment status; some titles or board
          details may be missing.
        </p>
      )}
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </output>
  )
}

/** How far the chain index has read, under a list built from it. */
export function IndexLine({
  chainReady,
  index,
  children,
}: {
  chainReady: boolean
  index: { next_block: number } | null
  children?: ReactNode
}) {
  return (
    <p className="px-4 text-xs text-muted-foreground">
      {!chainReady
        ? 'Chain facts are unavailable.'
        : index === null
          ? 'The chain index is not built yet.'
          : `Chain facts up to block ${(index.next_block - 1).toLocaleString('en-US')}, refreshed every minute.`}{' '}
      {children}
    </p>
  )
}
