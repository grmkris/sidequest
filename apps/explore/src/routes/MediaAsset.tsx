import { Link, useParams } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { CopyButton, LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { MediaFrame } from '../components/media/MediaFrame.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { type MediaAssetPage as MediaAssetPageData, useMediaAsset } from '../media-query.ts'
import { channelName, downloadUrl, downloads, durationText, postedWith, sizeText } from '../media.ts'

/**
 * `/media/<id>`: one asset, to watch, download, and post: its files, the suggested copy per channel with copy buttons,
 * and where it has been posted. An internal asset opens only for the media team.
 */
export function MediaAssetPage() {
  const { assetId } = useParams({ from: '/media/$assetId' })
  const page = useMediaAsset(assetId)
  if (page.isLoading) return <LoadingRows rows={3} />
  if (page.data === undefined)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Not in the media library</EmptyTitle>
          <EmptyDescription>
            It may have been unpublished. <Link to="/media">See what is published</Link>.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  const { asset, section, posts } = page.data
  const team = page.data.viewer.role !== null
  return (
    <>
      <header className="grid gap-2">
        <PageTitle {...(asset.description === undefined ? {} : { sub: asset.description })}>{asset.title}</PageTitle>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {section !== undefined && (
            <Link to="/media" className="hover:underline">
              {section.title}
            </Link>
          )}
          {asset.duration !== undefined && <span className="tabular-nums">{durationText(asset.duration)}</span>}
          {team && <Badge variant={asset.public ? 'success' : 'neutral'}>{asset.public ? 'Public' : 'Internal'}</Badge>}
        </p>
      </header>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <MediaFrame asset={asset} className="max-h-[80vh] justify-self-start" />
        <AssetSide asset={asset} posts={posts} />
      </div>
    </>
  )
}

/** Beside the frame: the files to download, the suggested copy per channel, and where it went out. */
function AssetSide({ asset, posts }: { asset: MediaAssetPageData['asset']; posts: MediaAssetPageData['posts'] }) {
  const posted = postedWith(posts)
  return (
    <div className="grid content-start gap-6">
      {asset.note !== undefined && <p className="text-sm text-warning-text">{asset.note}</p>}
      <Section title="Files">
        <ul className="grid gap-2">
          {downloads(asset).map(({ label, file }) => (
            <li key={file.name} className="flex flex-wrap items-center justify-between gap-2">
              <a
                href={downloadUrl(file.url!)}
                className={buttonVariants({ variant: label === 'Download' ? 'default' : 'outline', size: 'sm' })}
              >
                <Download data-icon="inline-start" />
                {label}
              </a>
              <span className="text-xs text-muted-foreground tabular-nums">{sizeText(file.bytes)}</span>
            </li>
          ))}
        </ul>
      </Section>
      {asset.captions.length > 0 && (
        <Section title="Suggested captions">
          <ul className="grid gap-4">
            {asset.captions.map((caption) => (
              <li
                key={`${caption.where}-${caption.text.slice(0, 16)}`}
                className="grid gap-2 rounded-lg bg-card p-3 shadow-stock"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{caption.where}</span>
                  <CopyButton value={caption.text} label="Copy" />
                </div>
                <p className="text-sm whitespace-pre-line">{caption.text}</p>
                {caption.note !== undefined && <p className="text-xs text-muted-foreground">{caption.note}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {posted.length > 0 && (
        <Section title="Posted on">
          <ul className="grid gap-1 text-sm">
            {posted.map((post) => (
              <li key={post.id}>
                <a href={post.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {channelName(post.channel)}
                  {post.account === undefined ? '' : `, ${post.account}`}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
