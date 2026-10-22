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
import { cn } from '../../lib/cn.ts'
import { CATEGORY_TINTS, coverOf } from '../../service-wall.ts'
import type { ServiceCategory, ServiceListing, ServiceSample } from '../../services.ts'

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

/**
 * A service's picture on its category's colour field, the seamless ground its covers are shot on. With no sample, or
 * one that cannot load, the field shows the category's mark, so the wall keeps its rhythm. The field is a picture
 * colour, the same in both themes; a hairline edge keeps it off the page in either.
 */
export function ServiceCover({
  listing,
  sample = coverOf(listing),
  className,
  imageClassName,
}: {
  listing: Pick<ServiceListing, 'samples' | 'category'>
  sample?: ServiceSample | null
  className?: string
  imageClassName?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const Icon = listing.category === undefined ? Sparkles : ICONS[listing.category]
  const shown = sample !== null && failed !== sample.url
  return (
    <div
      className={cn(
        'cover-print relative overflow-clip rounded-2xl bg-muted after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-foreground/10 after:ring-inset',
        className,
      )}
      style={listing.category === undefined ? undefined : { backgroundColor: CATEGORY_TINTS[listing.category] }}
    >
      {shown ? (
        <img
          src={sample.url}
          alt={sample.caption}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(sample.url)}
          className={cn('absolute inset-0 size-full object-cover', imageClassName)}
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-black/40">
          <Icon aria-hidden className="size-12" strokeWidth={1.25} />
        </span>
      )}
    </div>
  )
}
