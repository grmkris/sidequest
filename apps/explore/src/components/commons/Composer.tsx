import { X } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'
import { MESSAGE_MAX, type Message, type Viewer, composerGuidance, shortAddress } from '../../commons.ts'
import { usePost } from '../../commons-query.ts'
import { SideChip } from '../side/SideToken.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'

/**
 * Writing in a thread. The board decides who may post; the composer only explains its answer (sign in, or the SIDE it
 * needs) and keeps the draft when a post fails, so nothing typed is lost.
 */
export function Composer({
  subject,
  viewer,
  replyTo,
  onCancelReply,
  placeholder = 'Write a message',
}: {
  subject: string
  viewer: Viewer | null
  replyTo: Message | null
  onCancelReply: () => void
  placeholder?: string
}) {
  const auth = useAuth()
  const post = usePost()
  const [body, setBody] = useState('')
  const guidance = composerGuidance(viewer, auth.signedIn)
  // UTF-16 length is never below the board's code-point count, so this limit can only be stricter than the board's.
  const length = body.length
  const send = () => {
    const text = body.trim()
    if (text === '' || length > MESSAGE_MAX || post.isPending) return
    post.mutate(
      { subject, body: text, ...(replyTo === null ? {} : { replyTo: replyTo.id }) },
      {
        onSuccess: () => {
          setBody('')
          onCancelReply()
        },
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
      />
      <ComposerActions
        guidance={guidance}
        signedIn={auth.signedIn}
        pending={post.isPending}
        disabled={body.trim() === '' || length > MESSAGE_MAX}
        error={post.error?.message}
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
