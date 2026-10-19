import { X } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import type { AttachmentDraft } from './AttachmentEditor.tsx'

import { cn } from '../../lib/cn.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'
import { MESSAGE_MAX, type Message, type Viewer, composerGuidance, shortAddress } from '../../commons.ts'
import { usePost } from '../../commons-query.ts'
import { SideChip } from '../side/SideToken.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { EnhancementFallback } from './EnhancementFallback.tsx'

const AttachmentEditor = lazy(() => import('./AttachmentEditor.tsx'))
// Declared here, not imported, so the plan editor's chunk loads only when a plan is attached.
const NO_ATTACHMENT: AttachmentDraft = { source: '', value: null, error: null }

/**
 * Writing in a thread. The board decides who may post; the composer only explains its answer (sign in, or the SIDE it
 * needs) and keeps the draft when a post fails, so nothing typed is lost.
 */
interface ComposerProps {
  /** The post in flight and its attached plan, kept by the thread so a composer that moves under a post keeps them. */
  posting: ComposerPosting
  body: string
  onBodyChange: (body: string) => void
  draftRevision: number
  viewer: Viewer | null
  replyTo: Message | null
  onCancelReply: () => void
  placeholder?: string
  /** Start as one line, opening into the full editor once someone writes. */
  compact?: boolean
  /** Say what the reply answers, with a way to cancel; a post's own page answers that post and says neither. */
  replyContext?: boolean
}

export function Composer({
  posting,
  body,
  onBodyChange: setBody,
  draftRevision,
  viewer,
  replyTo,
  onCancelReply,
  placeholder = 'Write a message',
  compact = false,
  replyContext = true,
}: ComposerProps) {
  const auth = useAuth()
  const { post, attach, setAttach, attachment, setAttachment, send } = posting
  const guidance = composerGuidance(viewer, auth.signedIn)
  const length = body.length
  const [engaged, setEngaged] = useState(false)
  const collapsed = compact && !engaged && body === '' && !attach

  if (guidance !== null && auth.signedIn && viewer !== null)
    return (
      <p className="text-sm text-muted-foreground">
        {guidance} <SideChip variant="link">Get SIDE</SideChip>
      </p>
    )
  return (
    <form
      className={cn(
        'min-w-0 rounded-2xl bg-card shadow-chip transition-shadow duration-(--dur-fast)',
        collapsed
          ? 'flex items-center gap-2 py-1.5 ps-3 pe-1.5 focus-within:ring-3 focus-within:ring-ring/40'
          : 'grid grid-cols-1 gap-3 p-4',
      )}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {replyTo !== null && replyContext && <ReplyContext replyTo={replyTo} onCancel={onCancelReply} />}
      <MarkdownEditor
        label="Message"
        value={body}
        onChange={setBody}
        limit={MESSAGE_MAX}
        placeholder={placeholder}
        disabled={post.isPending}
        // Focus follows a Reply someone chose, never a page whose every reply answers its post.
        {...(replyTo === null || !replyContext ? {} : { replyId: replyTo.id })}
        focusRevision={draftRevision}
        collapsed={collapsed}
        onFocus={() => setEngaged(true)}
      />
      <ComposerActions
        guidance={guidance}
        signedIn={auth.signedIn}
        pending={post.isPending}
        disabled={collapsed || body.trim() === '' || length > MESSAGE_MAX || attachment.error !== null}
        error={post.error?.message}
        collapsed={collapsed}
      />
      {!collapsed && (
        <AttachmentPanel
          attach={attach}
          pending={post.isPending}
          draft={attachment}
          onChange={setAttachment}
          onToggle={() => {
            setAttach(!attach)
            setAttachment(NO_ATTACHMENT)
          }}
        />
      )}
    </form>
  )
}

type ComposerPosting = ReturnType<typeof useComposerPost>

export function useComposerPost({
  subject,
  body,
  replyTo,
  onPosted,
}: {
  subject: string
  body: string
  replyTo: Message | null
  onPosted: (submittedBody: string, submittedReplyTo: number | null) => void
}) {
  const post = usePost()
  const [attach, setAttach] = useState(false)
  const [attachment, setAttachment] = useState<AttachmentDraft>(NO_ATTACHMENT)
  const send = () => {
    const snapshotBody = body
    const snapshotReplyTo = replyTo?.id ?? null
    const text = body.trim()
    // UTF-16 length is a conservative bound for the board's code-point limit.
    if (text === '' || body.length > MESSAGE_MAX || post.isPending || attachment.error !== null) return
    void post
      .mutateAsync({
        subject,
        body: text,
        ...(replyTo === null ? {} : { replyTo: replyTo.id }),
        ...(attachment.value === null ? {} : { presentation: attachment.value }),
      })
      .then(
        () => {
          onPosted(snapshotBody, snapshotReplyTo)
          setAttach(false)
          setAttachment(NO_ATTACHMENT)
        },
        () => {
          /* The mutation exposes the error; retain the draft for a deliberate retry. */
        },
      )
  }
  return { post, attach, setAttach, attachment, setAttachment, send }
}

function ReplyContext({ replyTo, onCancel }: { replyTo: Message; onCancel: () => void }) {
  return (
    <div className="grid gap-1 border-s-2 border-primary ps-3 text-ui text-muted-foreground">
      <div className="flex items-center gap-2">
        <a href={`#m${replyTo.id}`} className="underline underline-offset-4">
          Replying to {shortAddress(replyTo.author)}
        </a>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel reply" onClick={onCancel}>
          <X aria-hidden />
        </Button>
      </div>
      {replyTo.hidden === null && <p className="line-clamp-2 [overflow-wrap:anywhere]">{replyTo.body}</p>}
    </div>
  )
}

function ComposerActions({
  guidance,
  signedIn,
  pending,
  disabled,
  error,
  collapsed,
}: {
  guidance: string | null
  signedIn: boolean
  pending: boolean
  disabled: boolean
  error: string | undefined
  collapsed: boolean
}) {
  const label = signedIn ? 'Post' : 'Sign in and post'
  // One line: the button beside the empty message, waiting for words.
  if (collapsed)
    return (
      // Concentric with the composer: its 16 px corner less the 6 px inset.
      <Button type="submit" className="min-h-11 shrink-0 rounded-[10px]" disabled>
        {label}
      </Button>
    )
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {guidance !== null && <span className="text-ui text-muted-foreground">{guidance}</span>}
        <Button type="submit" className="ms-auto min-h-11" busy={pending} disabled={disabled}>
          {label}
        </Button>
      </div>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  )
}

function AttachmentPanel({
  attach,
  pending,
  draft,
  onChange,
  onToggle,
}: {
  attach: boolean
  pending: boolean
  draft: AttachmentDraft
  onChange: (value: AttachmentDraft) => void
  onToggle: () => void
}) {
  return (
    <>
      <div>
        <Button variant="ghost" disabled={pending} aria-expanded={attach} onClick={onToggle}>
          {attach ? 'Remove plan attachment' : 'Attach interactive plan'}
        </Button>
      </div>
      {attach && (
        <EnhancementFallback fallback={<output>Plan editor could not load. Reload to try again.</output>}>
          <Suspense fallback={<output>Opening plan editor…</output>}>
            <AttachmentEditor disabled={pending} draft={draft} onChange={onChange} />
          </Suspense>
        </EnhancementFallback>
      )}
    </>
  )
}
