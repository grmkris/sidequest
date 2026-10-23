import { useState } from 'react'
import { useMediaWrite } from '../../media-query.ts'
import {
  CHANNEL_LIMITS,
  channelName,
  type MediaAsset,
  type MediaGroup,
  type MediaPost,
  PLAN_CHANNELS,
  postChecks,
} from '../../media.ts'
import { Select } from '../kit.tsx'
import { Sheet, useToast } from '../Sheet.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldDescription, FieldLabel } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { Textarea } from '../ui/textarea.tsx'

interface Draft {
  channel: string
  account: string
  day: string
  time: string
  text: string
  campaign: string
  assets: string[]
}
type SetDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => void

const draftOf = (post: MediaPost | undefined, campaign: string | undefined): Draft => ({
  channel: post?.channel ?? 'x',
  account: post?.account ?? '',
  day: post?.day ?? '',
  time: post?.time ?? '',
  text: post?.text ?? '',
  campaign: post?.campaign ?? campaign ?? '',
  assets: [...(post?.assets ?? [])],
})

/** The fields a save sends: empty ones cleared on an edit, left out on a new post. */
function argsOf(draft: Draft, post: MediaPost | undefined): Record<string, unknown> {
  const clear = post === undefined ? undefined : null
  const or = (value: string) => (value === '' ? clear : value)
  const args: Record<string, unknown> = {
    channel: draft.channel,
    text: draft.text,
    assets: draft.assets,
    account: or(draft.account),
    day: or(draft.day),
    time: or(draft.time),
    campaign: or(draft.campaign),
    ...(post?.note === undefined ? {} : { note: post.note }),
    ...(post === undefined ? {} : { id: post.id, revision: post.revision }),
  }
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

/** Where and when: the channel, the account, the day and the time. */
function WhereAndWhen({ draft, set }: { draft: Draft; set: SetDraft }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field>
        <FieldLabel htmlFor="post-channel">Channel</FieldLabel>
        <Select id="post-channel" value={draft.channel} onChange={(event) => set('channel', event.target.value)}>
          {PLAN_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {channelName(channel)}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="post-account">Account</FieldLabel>
        <Input
          id="post-account"
          value={draft.account}
          placeholder="@sidequest.exchange"
          onChange={(event) => set('account', event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="post-day">Day</FieldLabel>
        <Input id="post-day" type="date" value={draft.day} onChange={(event) => set('day', event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="post-time">Time</FieldLabel>
        <Input id="post-time" type="time" value={draft.time} onChange={(event) => set('time', event.target.value)} />
      </Field>
    </div>
  )
}

/** The files a post carries, internal ones marked: approving publishes those. */
function FilePicker({ draft, set, assets }: { draft: Draft; set: SetDraft; assets: readonly MediaAsset[] }) {
  const toggle = (id: string) =>
    set('assets', draft.assets.includes(id) ? draft.assets.filter((asset) => asset !== id) : [...draft.assets, id])
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Files</legend>
      <div className="grid max-h-48 gap-1 overflow-y-auto">
        {assets.map((asset) => (
          <label key={asset.id} className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.assets.includes(asset.id)} onChange={() => toggle(asset.id)} />
            <span className="min-w-0 truncate">{asset.title}</span>
            {!asset.public && <span className="text-xs text-muted-foreground">internal</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function CampaignPicker({ draft, set, campaigns }: { draft: Draft; set: SetDraft; campaigns: readonly MediaGroup[] }) {
  if (campaigns.length === 0) return null
  return (
    <Field>
      <FieldLabel htmlFor="post-campaign">Campaign</FieldLabel>
      <Select id="post-campaign" value={draft.campaign} onChange={(event) => set('campaign', event.target.value)}>
        <option value="">None</option>
        {campaigns.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.title}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/**
 * Plan a post or change one (ADR-0029): where it goes, when, what it says and which files it carries. Saving an edit
 * of an approved post returns it to draft, so it is approved again as it now reads.
 */
export function PostEditor(props: {
  open: boolean
  onClose: () => void
  post?: MediaPost
  assets: readonly MediaAsset[]
  campaigns: readonly MediaGroup[]
  campaign?: string
}) {
  const { post, assets, onClose } = props
  const [draft, setDraft] = useState<Draft>(() => draftOf(post, props.campaign))
  const save = useMediaWrite('save_media_post')
  const toast = useToast()
  const set: SetDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const limit = CHANNEL_LIMITS[draft.channel]
  const checks = postChecks(draft, assets)
  const submit = () =>
    save.mutate(argsOf(draft, post), {
      onSuccess: () => {
        toast(post?.status === 'approved' ? 'Saved; it needs approving again' : 'Saved')
        onClose()
      },
      onError: (error) => toast(error.message, 'error'),
    })
  return (
    <Sheet open={props.open} onClose={onClose} title={post === undefined ? 'Plan a post' : 'Change the post'}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <WhereAndWhen draft={draft} set={set} />
        <Field>
          <FieldLabel htmlFor="post-text">Text</FieldLabel>
          <Textarea
            id="post-text"
            rows={5}
            value={draft.text}
            onChange={(event) => set('text', event.target.value)}
            required
          />
          {limit !== undefined && (
            <FieldDescription className="tabular-nums">
              {draft.text.length} of {limit}
            </FieldDescription>
          )}
        </Field>
        <CampaignPicker draft={draft} set={set} campaigns={props.campaigns} />
        <FilePicker draft={draft} set={set} assets={assets} />
        {checks.length > 0 && (
          <ul className="grid gap-1 text-xs text-warning-text">
            {checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        )}
        <Button type="submit" busy={save.isPending} disabled={draft.text.trim() === ''}>
          {post === undefined ? 'Plan it' : 'Save'}
        </Button>
      </form>
    </Sheet>
  )
}
