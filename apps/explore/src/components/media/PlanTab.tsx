import { useState } from 'react'
import { useMediaPosts, useMediaWrite } from '../../media-query.ts'
import {
  channelName,
  type MediaAsset,
  type MediaGroup,
  type MediaPost,
  planDays,
  postChecks,
  todayOf,
} from '../../media.ts'
import { LoadingRows, Section } from '../kit.tsx'
import { ConfirmSheet, Sheet, useToast } from '../Sheet.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { PostEditor } from './PostEditor.tsx'

const STATUS = {
  draft: { label: 'Draft', variant: 'neutral' },
  approved: { label: 'Approved', variant: 'info' },
  posted: { label: 'Posted', variant: 'success' },
  skipped: { label: 'Skipped', variant: 'neutral' },
} as const

/**
 * The post plan (ADR-0029): every post by day, its channel, time, text, files and what to fix before it goes out.
 * Members plan, change, skip and record posts; operators approve them. Posting is done by hand or by an agent with a
 * browser; recording the post's URL closes it.
 */
export function PlanTab({
  assets,
  campaigns,
  operator,
}: {
  assets: readonly MediaAsset[]
  campaigns: readonly MediaGroup[]
  operator: boolean
}) {
  const posts = useMediaPosts()
  const [planning, setPlanning] = useState(false)
  if (posts.isLoading) return <LoadingRows rows={4} />
  if (posts.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>The plan did not load.</AlertDescription>
      </Alert>
    )
  const days = planDays(posts.data?.posts ?? [], todayOf())
  return (
    <>
      <div>
        <Button onClick={() => setPlanning(true)}>Plan a post</Button>
      </div>
      {days.length === 0 && <p className="text-sm text-muted-foreground">Nothing planned yet.</p>}
      {days.map((day) => (
        <Section key={day.day ?? 'undated'} title={day.label}>
          <ul className="grid gap-3">
            {day.posts.map((post) => (
              <PostRow key={post.id} post={post} assets={assets} campaigns={campaigns} operator={operator} />
            ))}
          </ul>
        </Section>
      ))}
      {planning && <PostEditor open onClose={() => setPlanning(false)} assets={assets} campaigns={campaigns} />}
    </>
  )
}

/** A skip or an approval names the post as read; a save keeps every field it does not send. */
const keepOf = (post: MediaPost) => ({ id: post.id, revision: post.revision, channel: post.channel, text: post.text })

interface RowProps {
  post: MediaPost
  assets: readonly MediaAsset[]
  campaigns: readonly MediaGroup[]
  operator: boolean
}

function PostRow(props: RowProps) {
  const { post, assets } = props
  const checks = postChecks(post, assets)
  const open = post.status === 'draft' || post.status === 'approved'
  const status = STATUS[post.status]
  return (
    <li className="grid gap-2 rounded-lg bg-card p-3 shadow-stock">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {[post.time, channelName(post.channel), post.account].filter((part) => part !== undefined).join(' ')}
        </span>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="text-sm whitespace-pre-line">{post.text}</p>
      {post.assets.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {post.assets.map((id) => assets.find((asset) => asset.id === id)?.title ?? id).join(', ')}
        </p>
      )}
      {open && checks.length > 0 && (
        <ul className="grid gap-0.5 text-xs text-warning-text">
          {checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      )}
      {post.url !== undefined && (
        <a href={post.url} target="_blank" rel="noreferrer" className="text-xs hover:underline">
          The post
        </a>
      )}
      {open && <PostActions {...props} />}
    </li>
  )
}

/** Approve (an operator), record once out, change or skip; each sends the post as it is with the one change. */
function PostActions({ post, assets, campaigns, operator }: RowProps) {
  const [editing, setEditing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [recording, setRecording] = useState(false)
  const toast = useToast()
  const save = useMediaWrite('save_media_post')
  const internal = assets.filter((asset) => post.assets.includes(asset.id) && !asset.public)
  const fail = (error: Error) => toast(error.message, 'error')
  const approve = () =>
    save.mutate(
      { ...keepOf(post), status: 'approved', ...(internal.length === 0 ? {} : { publishAssets: true }) },
      { onSuccess: () => setApproving(false), onError: fail },
    )
  return (
    <div className="flex flex-wrap gap-2">
      {operator && post.status === 'draft' && (
        <Button size="sm" onClick={() => setApproving(true)}>
          Approve
        </Button>
      )}
      {post.status === 'approved' && (
        <Button size="sm" onClick={() => setRecording(true)}>
          Record the post
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
        Change
      </Button>
      <Button
        size="sm"
        variant="ghost"
        busy={save.isPending}
        onClick={() => save.mutate({ ...keepOf(post), status: 'skipped' }, { onError: fail })}
      >
        Skip
      </Button>
      {editing && (
        <PostEditor open onClose={() => setEditing(false)} post={post} assets={assets} campaigns={campaigns} />
      )}
      <ConfirmSheet
        open={approving}
        onClose={() => setApproving(false)}
        title="Approve this post?"
        description={
          internal.length === 0
            ? 'It can go out as it reads now. Changing it later needs approving again.'
            : `Approving also publishes ${internal.map((asset) => asset.title).join(', ')} on /media.`
        }
        confirm={internal.length === 0 ? 'Approve' : 'Publish and approve'}
        busy={save.isPending}
        onConfirm={approve}
      />
      {recording && <RecordPost post={post} onClose={() => setRecording(false)} />}
    </div>
  )
}

/** Recording a post that went out: its public link closes it in the plan. */
function RecordPost({ post, onClose }: { post: MediaPost; onClose: () => void }) {
  const [url, setUrl] = useState('')
  const record = useMediaWrite('record_media_post')
  const toast = useToast()
  return (
    <Sheet open onClose={onClose} title="Record the post">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          record.mutate(
            { id: post.id, url },
            { onSuccess: () => onClose(), onError: (error) => toast(error.message, 'error') },
          )
        }}
      >
        <Field>
          <FieldLabel htmlFor="post-url">The post's link on {channelName(post.channel)}</FieldLabel>
          <Input id="post-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Button type="submit" busy={record.isPending}>
          Record it
        </Button>
      </form>
    </Sheet>
  )
}
