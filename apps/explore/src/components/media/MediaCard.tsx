import { Link } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { cn } from '../../lib/cn.ts'
import { downloadUrl, durationText, mainFile, type MediaAsset, sizeText } from '../../media.ts'
import { CopyButton } from '../kit.tsx'
import { Badge } from '../ui/badge.tsx'
import { buttonVariants } from '../ui/button.tsx'
import { MediaFrame } from './MediaFrame.tsx'

/**
 * One asset on a shelf: its frame, its title (to its own page), what it is in a short line, and the two things people
 * come for: the download and the link. The team also sees its level and batch.
 */
export function MediaCard({
  asset,
  team = false,
  className,
}: {
  asset: MediaAsset
  team?: boolean
  className?: string
}) {
  const main = mainFile(asset)
  const facts = [
    asset.duration === undefined ? undefined : durationText(asset.duration),
    main === undefined ? undefined : sizeText(main.bytes),
  ].filter((fact): fact is string => fact !== undefined)
  return (
    <article className={cn('grid min-w-0 content-start gap-3', className)}>
      <MediaFrame asset={asset} />
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <Link
            to="/media/$assetId"
            params={{ assetId: asset.id }}
            className="min-w-0 text-sm font-semibold [overflow-wrap:break-word] hover:underline"
          >
            {asset.title}
          </Link>
          {team && (
            <Badge variant={asset.public ? 'success' : 'neutral'} className="shrink-0">
              {asset.public ? 'Public' : 'Internal'}
            </Badge>
          )}
        </div>
        {facts.length > 0 && (
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </p>
        )}
        {asset.note !== undefined && <p className="text-xs text-warning-text">{asset.note}</p>}
        {team && asset.batch !== undefined && (
          <p className="text-xs text-muted-foreground">
            {asset.batch}
            {asset.picked ? ', picked' : ''}
          </p>
        )}
      </div>
      {main?.url != null && (
        <div className="flex flex-wrap gap-2">
          <a href={downloadUrl(main.url)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <Download data-icon="inline-start" />
            Download
          </a>
          {asset.public && <CopyButton value={main.url} label="Copy link" />}
        </div>
      )}
    </article>
  )
}
