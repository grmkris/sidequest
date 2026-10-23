import { useState } from 'react'
import { useMediaWrite } from '../../media-query.ts'
import type { MediaAsset, MediaGroup, MediaPost } from '../../media.ts'
import { Sheet, useToast } from '../Sheet.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { Textarea } from '../ui/textarea.tsx'

/**
 * Campaigns (ADR-0029): one story told across channels, with its window, its assets and its posts. Any team member
 * starts one; the brief is a document asset in the library.
 */
export function CampaignsTab({
  campaigns,
  assets,
  posts,
}: {
  campaigns: readonly MediaGroup[]
  assets: readonly MediaAsset[]
  posts: readonly MediaPost[]
}) {
  const [adding, setAdding] = useState(false)
  return (
    <>
      <div>
        <Button onClick={() => setAdding(true)}>Start a campaign</Button>
      </div>
      {campaigns.length === 0 && <p className="text-sm text-muted-foreground">No campaigns yet.</p>}
      <ul className="grid gap-3">
        {campaigns.map((campaign) => {
          const own = assets.filter((asset) => asset.campaign === campaign.id)
          const planned = posts.filter((post) => post.campaign === campaign.id)
          return (
            <li key={campaign.id} className="grid gap-1 rounded-lg bg-card p-3 shadow-stock">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-lg">{campaign.title}</span>
                {campaign.status !== undefined && <Badge variant="neutral">{campaign.status}</Badge>}
              </div>
              {campaign.note !== undefined && <p className="text-sm text-muted-foreground">{campaign.note}</p>}
              <p className="text-xs text-muted-foreground tabular-nums">
                {campaign.startsOn === undefined
                  ? 'No window yet'
                  : `${campaign.startsOn} to ${campaign.endsOn ?? 'open'}`}
                {`, ${own.length} ${own.length === 1 ? 'asset' : 'assets'}, ${planned.filter((post) => post.status === 'posted').length} of ${planned.length} posts out`}
              </p>
            </li>
          )
        })}
      </ul>
      {adding && <NewCampaign onClose={() => setAdding(false)} />}
    </>
  )
}

function NewCampaign({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const save = useMediaWrite('save_media_group')
  const toast = useToast()
  return (
    <Sheet open onClose={onClose} title="Start a campaign">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate(
            {
              kind: 'campaign',
              title,
              status: 'planning',
              ...(note === '' ? {} : { note }),
              ...(startsOn === '' ? {} : { startsOn }),
              ...(endsOn === '' ? {} : { endsOn }),
            },
            { onSuccess: () => onClose(), onError: (error) => toast(error.message, 'error') },
          )
        }}
      >
        <Field>
          <FieldLabel htmlFor="campaign-title">Title</FieldLabel>
          <Input id="campaign-title" required value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="campaign-note">What it is for</FieldLabel>
          <Textarea id="campaign-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="campaign-from">From</FieldLabel>
            <Input
              id="campaign-from"
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="campaign-to">To</FieldLabel>
            <Input id="campaign-to" type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
          </Field>
        </div>
        <Button type="submit" busy={save.isPending} disabled={title.trim() === ''}>
          Start it
        </Button>
      </form>
    </Sheet>
  )
}
