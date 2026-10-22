import { AudioLines, Box, Blocks, FileArchive, FileDiff, Film, GitCommitHorizontal, Globe } from 'lucide-react'
import type { Deliverable } from '../../api.ts'
import { cn } from '../../lib/cn.ts'

const GLYPH = {
  url: Globe,
  artifact: FileArchive,
  git: GitCommitHorizontal,
  patch: FileDiff,
  onchain: Blocks,
} as const

/**
 * What was delivered, drawn when there is no picture of it: a glyph for its kind (a model, a video or audio when it is
 * one), its kind in words and what identifies it.
 */
export function KindGlyph({
  kind,
  media = null,
  model = false,
  label,
  detail,
  className,
}: {
  kind: Deliverable['kind'] | null
  media?: 'video' | 'audio' | null
  model?: boolean
  label: string
  detail: string
  className?: string
}) {
  const Icon = model
    ? Box
    : media === 'video'
      ? Film
      : media === 'audio'
        ? AudioLines
        : kind === null
          ? Globe
          : GLYPH[kind]
  return (
    <span
      className={cn(
        'flex flex-col items-center justify-center gap-2 bg-[radial-gradient(120%_100%_at_50%_0%,var(--color-muted),transparent)] px-4 text-center text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-9 stroke-[1.25]" />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="max-w-full truncate font-mono text-xs">{detail}</span>
      </span>
    </span>
  )
}
