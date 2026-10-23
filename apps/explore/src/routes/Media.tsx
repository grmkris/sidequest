import { Link } from '@tanstack/react-router'
import { LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { MediaCard } from '../components/media/MediaCard.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { cn } from '../lib/cn.ts'
import { useMediaLibrary } from '../media-query.ts'
import { shelves } from '../media.ts'

/**
 * `/media` (ADR-0029): Sidequest's public media kit, shelf by shelf as the media team orders it, the featured shelf
 * first and larger. Everyone sees what is public; the team also gets a way into the internal library.
 */
export function MediaPage() {
  const library = useMediaLibrary()
  const team = (library.data?.viewer.role ?? null) !== null
  const publicOnly =
    library.data === undefined
      ? undefined
      : { ...library.data, assets: library.data.assets.filter((asset) => asset.public) }
  const list = publicOnly === undefined ? [] : shelves(publicOnly)
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <PageTitle sub="Sidequest's films, pictures and briefs. Download any of them, or copy its link.">
          Media
        </PageTitle>
        {team && (
          <Link to="/media/internal" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Internal library
          </Link>
        )}
      </header>
      {library.isLoading && <LoadingRows rows={4} />}
      {library.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>The media library did not load. Try again in a moment.</AlertDescription>
        </Alert>
      )}
      {library.data !== undefined && list.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing is published yet.</p>
      )}
      {list.map((shelf) => (
        <Section key={shelf.id} title={shelf.title} {...(shelf.note === undefined ? {} : { note: shelf.note })}>
          <div
            className={cn(
              'grid gap-x-5 gap-y-8',
              shelf.featured ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4',
            )}
          >
            {shelf.assets.map((asset) => (
              <MediaCard key={asset.id} asset={asset} />
            ))}
          </div>
        </Section>
      ))}
    </>
  )
}
