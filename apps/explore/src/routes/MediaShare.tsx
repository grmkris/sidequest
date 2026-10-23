import { useParams } from '@tanstack/react-router'
import { LoadingRows, PageTitle } from '../components/kit.tsx'
import { MediaCard } from '../components/media/MediaCard.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { useMediaShare } from '../media-query.ts'

const until = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * `/media/s/<token>` (ADR-0029): what someone on the media team shared with you, to download without signing in, until
 * the link expires or is revoked. The link is the key: keep it to yourself.
 */
export function MediaSharePage() {
  const { token } = useParams({ from: '/media/s/$token' })
  const share = useMediaShare(token)
  if (share.isLoading) return <LoadingRows rows={3} />
  if (share.data === undefined)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>This link has expired</EmptyTitle>
          <EmptyDescription>Ask whoever sent it for a new one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <>
      <PageTitle
        sub={`Shared by Sidequest's media team until ${until(share.data.expiresAt)}. Please keep this link to yourself.`}
      >
        {share.data.label ?? 'Shared media'}
      </PageTitle>
      <div className="grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-3">
        {share.data.assets.map((asset) => (
          <MediaCard key={asset.id} asset={asset} />
        ))}
      </div>
    </>
  )
}
