import {
  Box,
  Clapperboard,
  Code,
  Database,
  FileText,
  Gamepad2,
  Globe,
  Image,
  Languages,
  Link,
  Mic,
  Search,
  Sparkles,
} from 'lucide-react'
import { useState } from 'react'
import { CATEGORY_LABELS, coverOf } from '../../service-wall.ts'
import type { ServiceListing, ServiceCategory } from '../../services.ts'

const ICONS = {
  video: Clapperboard,
  audio: Mic,
  image: Image,
  '3d': Box,
  site: Globe,
  game: Gamepad2,
  research: Search,
  writing: FileText,
  translation: Languages,
  data: Database,
  code: Code,
  onchain: Link,
} satisfies Record<ServiceCategory, typeof Box>

/** A stable cover box, including when a remote sample cannot load. */
export function ServiceCover({ listing }: { listing: ServiceListing }) {
  const sample = coverOf(listing)
  const [failed, setFailed] = useState<string | null>(null)
  const Icon = listing.category === undefined ? Sparkles : ICONS[listing.category]
  return (
    <div className="aspect-4/3 overflow-clip rounded-lg bg-muted">
      {sample !== null && failed !== sample.url ? (
        <img
          src={sample.url}
          alt={sample.caption}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(sample.url)}
          className="size-full rounded-lg object-cover ring-1 ring-foreground/10"
        />
      ) : (
        <div className="flex h-full flex-col justify-between gap-4 p-6 text-muted-foreground">
          <span className="flex items-center gap-2 text-xs">
            <Icon aria-hidden className="size-7" strokeWidth={1.25} />
            {CATEGORY_LABELS.find((item) => item.value === listing.category)?.label ?? 'Service'}
          </span>
          <span className="line-clamp-2 font-display text-3xl leading-tight text-balance text-foreground [overflow-wrap:anywhere]">
            {listing.name}
          </span>
        </div>
      )}
    </div>
  )
}
