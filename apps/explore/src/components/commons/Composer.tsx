import { X } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import type { AttachmentDraft } from './AttachmentEditor.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'
import { MESSAGE_MAX, type Message, type Viewer, composerGuidance, shortAddress } from '../../commons.ts'
import { usePost } from '../../commons-query.ts'
import { SideChip } from '../side/SideToken.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { EnhancementFallback } from './EnhancementFallback.tsx'

const AttachmentEditor = lazy(() => import('./AttachmentEditor.tsx'))

/**
 * Writing in a thread. The board decides who may post; the composer only explains its answer (sign in, or the SIDE it
 * needs) and keeps the draft when a post fails, so nothing typed is lost.
 */
interface ComposerProps {
  subject: string
  body: string
  onBodyChange: (body: string) => void
  draftRevision: number
  viewer: Viewer | null
  replyTo: Message | null
  onCancelReply: () => void
  onPosted: (submittedBody: string, submittedReplyTo: number | null) => void
  placeholder?: string
}

export function Composer({
  subject,
  body,
  onBodyChange: setBody,
  draftRevision,
  viewer,
  replyTo,
  onCancelReply,
  onPosted,
  placeholder = 'Write a message',
}: ComposerProps) {
  const auth = useAuth()
  const post = usePost()
  const [attach, setAttach] = useState(false)
  const [attachment, setAttachment] = useState<AttachmentDraft>({ value: null, error: null })
  const guidance = composerGuidance(viewer, auth.signedIn)
  // UTF-16 length is never below the board's code-point count, so this limit can only be stricter than the board's.
  const length = body.length
  const send = () => {
    const snapshotBody = body
    const snapshotReplyTo = replyTo?.id ?? null
    const text = body.trim()
    if (text === '' || length > MESSAGE_MAX || post.isPending || attachment.error !== null) return
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
          setAttachment({ value: null, error: null })
        },
        () => {
          // The mutation exposes the error; retain the draft for a deliberate retry.
        },
      )
  }
  if (guidance !== null && auth.signedIn && viewer !== null)
    return (
      <p className="text-sm text-muted-foreground">
        {guidance} <SideChip variant="link">Get SIDE</SideChip>
      </p>
    )
  return (
    <form
      className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {replyTo !== null && <ReplyContext replyTo={replyTo} onCancel={onCancelReply} />}
      <MarkdownEditor
        label="Message"
        value={body}
        onChange={setBody}
        limit={MESSAGE_MAX}
        placeholder={placeholder}
        disabled={post.isPending}
        {...(replyTo === null ? {} : { replyId: replyTo.id })}
        focusRevision={draftRevision}
      />
      <ComposerActions
        guidance={guidance}
        signedIn={auth.signedIn}
        pending={post.isPending}
        disabled={body.trim() === '' || length > MESSAGE_MAX || attachment.error !== null}
        error={post.error?.message}
      />
      <AttachmentPanel
        attach={attach}
        pending={post.isPending}
        onChange={setAttachment}
        onToggle={() => {
          setAttach(!attach)
          setAttachment({ value: null, error: null })
        }}
      />
    </form>
  )
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
}: {
  guidance: string | null
  signedIn: boolean
  pending: boolean
  disabled: boolean
  error: string | undefined
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {guidance !== null && <span className="text-ui text-muted-foreground">{guidance}</span>}
        <Button type="submit" className="ms-auto min-h-11" busy={pending} disabled={disabled}>
          {signedIn ? 'Post' : 'Sign in and post'}
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
  onChange,
  onToggle,
}: {
  attach: boolean
  pending: boolean
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
        <EnhancementFallback fallback={<p role="status">Plan editor could not load. Reload to try again.</p>}>
          <Suspense fallback={<output>Opening plan editor…</output>}>
            <AttachmentEditor disabled={pending} onChange={onChange} />
          </Suspense>
        </EnhancementFallback>
      )}
    </>
  )
}
