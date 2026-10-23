import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { CopyButton, LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { MediaCard } from '../components/media/MediaCard.tsx'
import { ConfirmSheet, useToast } from '../components/Sheet.tsx'
import { SignIn } from '../components/SignIn.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { useMediaLibrary, useMediaShares, useMediaWrite } from '../media-query.ts'
import { campaignsOf, type MediaAsset, type MediaLibrary } from '../media.ts'
import { useReplaceSearch } from '../page-search.ts'

const TABS = ['library', 'shares'] as const
type Tab = (typeof TABS)[number]
const tabOf = (search: string): Tab => {
  const asked = new URLSearchParams(search).get('tab')
  return TABS.find((tab) => tab === asked) ?? 'library'
}

/**
 * `/media/internal` (ADR-0029): the media team's library. Every asset at both levels, a campaign's variants side by
 * side; operators publish and unpublish, anyone on the team shares. Nobody else sees past the sign-in.
 */
export function MediaInternalPage() {
  const auth = useAuth()
  const library = useMediaLibrary()
  const [tab, setTab] = useState<Tab>(() => tabOf(window.location.search))
  const replaceSearch = useReplaceSearch()
  if (!auth.signedIn)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Sign in to see the media library</EmptyTitle>
          <EmptyDescription>Only Sidequest's media team sees internal media.</EmptyDescription>
        </EmptyHeader>
        <SignIn auth={auth} />
      </Empty>
    )
  if (library.isLoading) return <LoadingRows rows={4} />
  const role = library.data?.viewer.role ?? null
  if (library.data === undefined || role === null)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Only the media team sees this</EmptyTitle>
          <EmptyDescription>
            This wallet is not on Sidequest's media team. <Link to="/media">The public media</Link> is open to everyone.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <PageTitle sub="Everything the team made, internal and public. Agents upload here; what is public is on /media.">
          Media library
        </PageTitle>
        <Badge variant="neutral">Media {role}</Badge>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = tabOf(`?tab=${String(value)}`)
          setTab(next)
          replaceSearch(next === 'library' ? '' : `?tab=${next}`)
        }}
      >
        <TabsList>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="shares">Shares</TabsTrigger>
        </TabsList>
        <TabsContent value="library" className="grid gap-8 pt-4">
          <Library library={library.data} operator={role === 'operator'} />
        </TabsContent>
        <TabsContent value="shares" className="grid gap-8 pt-4">
          <Shares />
        </TabsContent>
      </Tabs>
    </>
  )
}

function Library({ library, operator }: { library: MediaLibrary; operator: boolean }) {
  const { grouped, rest } = campaignsOf(library)
  return (
    <>
      {grouped.map(({ campaign, batches }) => (
        <Section
          key={campaign.id}
          title={campaign.title}
          {...(campaign.note === undefined ? {} : { note: campaign.note })}
        >
          <div className="grid gap-8">
            {batches.map((batch) => (
              <div key={batch.batch ?? batch.assets[0]!.id} className="grid gap-3">
                {batch.batch !== undefined && <h3 className="text-sm font-semibold">{batch.batch}</h3>}
                <div className="grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-3 xl:grid-cols-4">
                  {batch.assets.map((asset) => (
                    <TeamCard key={asset.id} asset={asset} operator={operator} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ))}
      {rest.length > 0 && (
        <Section title={grouped.length === 0 ? 'Everything' : 'Not in a campaign'}>
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-3 xl:grid-cols-4">
            {rest.map((asset) => (
              <TeamCard key={asset.id} asset={asset} operator={operator} />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

/** A card with the team's actions: share it, and for an operator, publish or unpublish it. */
function TeamCard({ asset, operator }: { asset: MediaAsset; operator: boolean }) {
  const toast = useToast()
  const publish = useMediaWrite<{ id: string; public: boolean }>('publish_media')
  const share = useMediaWrite<{ assets: string[]; label: string }, { url: string }>('share_media')
  const [asking, setAsking] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  return (
    <div className="grid content-start gap-2">
      <MediaCard asset={asset} team />
      <div className="flex flex-wrap gap-2">
        {operator && (
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
            {asset.public ? 'Unpublish' : 'Publish'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          busy={share.isPending}
          onClick={() =>
            share.mutate(
              { assets: [asset.id], label: asset.title },
              { onSuccess: (reply) => setLink(reply.url), onError: (error) => toast(error.message, 'error') },
            )
          }
        >
          Share
        </Button>
      </div>
      {link !== null && (
        <div className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Anyone with this link can download it for 30 days.</span>
          <CopyButton value={link} label="Copy share link" />
        </div>
      )}
      <ConfirmSheet
        open={asking}
        onClose={() => setAsking(false)}
        title={asset.public ? `Unpublish ${asset.title}?` : `Publish ${asset.title}?`}
        description={
          asset.public
            ? 'It leaves /media and its links stop working at once.'
            : 'It goes on /media and anyone can download it. What is public is a claim Sidequest makes.'
        }
        confirm={asset.public ? 'Unpublish' : 'Publish'}
        busy={publish.isPending}
        onConfirm={() =>
          publish.mutate(
            { id: asset.id, public: !asset.public },
            { onSuccess: () => setAsking(false), onError: (error) => toast(error.message, 'error') },
          )
        }
      />
    </div>
  )
}

function Shares() {
  const shares = useMediaShares(true)
  const toast = useToast()
  const revoke = useMediaWrite<{ id: string }>('revoke_media_share')
  if (shares.isLoading) return <LoadingRows rows={3} />
  if (shares.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>The shares did not load.</AlertDescription>
      </Alert>
    )
  const list = shares.data?.shares ?? []
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No share links yet.</p>
  return (
    <ul className="grid gap-3">
      {list.map((row) => (
        <li
          key={row.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card p-3 shadow-stock"
        >
          <div className="grid min-w-0 gap-0.5">
            <span className="text-sm font-semibold">{row.label ?? row.id}</span>
            <span className="text-xs text-muted-foreground">
              {row.assets.length} {row.assets.length === 1 ? 'asset' : 'assets'}, by {row.createdBy}
            </span>
          </div>
          {row.live ? (
            <Button
              size="sm"
              variant="outline"
              busy={revoke.isPending}
              onClick={() => revoke.mutate({ id: row.id }, { onError: (error) => toast(error.message, 'error') })}
            >
              Revoke
            </Button>
          ) : (
            <Badge variant="neutral">Ended</Badge>
          )}
        </li>
      ))}
    </ul>
  )
}
