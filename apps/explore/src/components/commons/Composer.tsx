import { X } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { useAuth } from '../Wallet.tsx'
import { MESSAGE_MAX, type Message, type Viewer, composerGuidance, shortAddress } from '../../commons.ts'
import { usePost } from '../../commons-query.ts'
import { SideChip } from '../side/SideToken.tsx'

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
  const send = async () => {
    const text = body.trim()
    if (text === '' || length > MESSAGE_MAX) return
    await post.mutateAsync({ subject, body: text, ...(replyTo === null ? {} : { replyTo: replyTo.id }) })
    setBody('')
    onCancelReply()
  }
  if (guidance !== null && auth.signedIn && viewer !== null)
    return (
      <p className="text-sm text-muted-foreground">
        {guidance} <SideChip variant="link">Get SIDE</SideChip>
      </p>
    )
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      {replyTo !== null && (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          Replying to {shortAddress(replyTo.author)}
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel reply" onClick={onCancelReply}>
            <X aria-hidden />
          </Button>
        </p>
      )}
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={placeholder}
        aria-label="Message"
        rows={3}
        aria-invalid={length > MESSAGE_MAX}
      />
      <div className="flex items-center gap-3">
        <span className="text-micro text-muted-foreground tabular-nums">
          {length} / {MESSAGE_MAX}
        </span>
        {guidance !== null && <span className="text-ui text-muted-foreground">{guidance}</span>}
        <Button
          type="submit"
          className="ml-auto"
          busy={post.isPending}
          disabled={body.trim() === '' || length > MESSAGE_MAX}
        >
          {auth.signedIn ? 'Post' : 'Sign in and post'}
        </Button>
      </div>
      {post.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{post.error.message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}
