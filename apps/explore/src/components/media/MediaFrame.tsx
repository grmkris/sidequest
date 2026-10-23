import { FileText, Music, Play } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { captionTrack, mainFile, type MediaAsset, posterOf, shapeOf } from '../../media.ts'

const ASPECT = { vertical: 'aspect-[9/16]', square: 'aspect-square', landscape: 'aspect-video' } as const

/**
 * A media asset in its own frame (ADR-0029): a film with its poster, playing in place once asked (native controls, the
 * captions track when there is one); a picture; or a document's mark. The frame keeps the asset's shape, so a shelf of
 * vertical cuts and wide films keeps its rhythm.
 */
export function MediaFrame({
  asset,
  className,
  autoPlay = false,
}: {
  asset: MediaAsset
  className?: string
  /** Start playing at once (an asset's own page); a card plays on its first click. */
  autoPlay?: boolean
}) {
  const [playing, setPlaying] = useState(autoPlay)
  const [failed, setFailed] = useState(false)
  const main = mainFile(asset)
  const poster = posterOf(asset)
  const track = captionTrack(asset)
  const frame = cn(
    'relative overflow-clip rounded-xl bg-muted after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-foreground/10 after:ring-inset',
    ASPECT[shapeOf(asset)],
    className,
  )
  if (asset.kind === 'video' && main?.url != null) {
    if (playing)
      return (
        <div className={frame}>
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- Sidequest's films burn their captions in; a WebVTT track is added below whenever one was uploaded */}
          <video
            className="absolute inset-0 size-full bg-black object-contain"
            src={main.url}
            poster={poster?.url ?? undefined}
            controls
            playsInline
            autoPlay
            preload="metadata"
          >
            {track?.url != null && <track kind="captions" src={track.url} srcLang="en" label="English" default />}
          </video>
        </div>
      )
    return (
      <button type="button" className={cn(frame, 'group block w-full text-left')} onClick={() => setPlaying(true)}>
        {poster?.url != null && !failed && (
          <img
            src={poster.url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-12 place-items-center rounded-full bg-background/90 shadow-stock transition-transform group-hover:-translate-y-px">
            <Play aria-hidden className="size-5 translate-x-px" />
          </span>
        </span>
        <span className="sr-only">Play {asset.title}</span>
      </button>
    )
  }
  if (asset.kind === 'image' && main?.url != null && !failed)
    return (
      <div className={frame}>
        <img
          src={main.url}
          alt={asset.title}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      </div>
    )
  const Icon = asset.kind === 'audio' ? Music : FileText
  return (
    <div className={frame}>
      <span className="absolute inset-0 grid place-items-center text-muted-foreground">
        <Icon aria-hidden className="size-10" strokeWidth={1.25} />
      </span>
    </div>
  )
}
