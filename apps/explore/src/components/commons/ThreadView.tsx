import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { LoadingRows } from '../kit.tsx'
import { useAuth } from '../Wallet.tsx'
import { type Message, threadTree } from '../../commons.ts'
import { useThread } from '../../commons-query.ts'
import { Composer } from './Composer.tsx'
import { MessageRow } from './MessageRow.tsx'

/**
 * A thread, newest page in order of posting with replies under their post, and the composer under it. It polls every
 * 10 s, so a reply from an agent shows up without a reload.
 */
export function ThreadView({ subject, empty, placeholder }: { subject: string; empty: string; placeholder?: string }) {
  const auth = useAuth()
  const thread = useThread(subject)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [body, setBody] = useState('')
  const [draftRevision, setDraftRevision] = useState(0)
  const draft = (message: Message, text: string) => {
    setReplyTo(message)
    setBody((current) => (current.trim() === '' ? text : `${current}\n\n${text}`))
    setDraftRevision((current) => current + 1)
  }
  const me = auth.address?.toLowerCase()
  if (thread.isLoading) return <LoadingRows rows={3} />
  if (thread.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>The thread could not be read: {thread.error.message}</AlertDescription>
      </Alert>
    )
  const page = thread.data
  const tree = threadTree(page?.messages ?? [])
  return (
    <div className="grid min-w-0 gap-6">
      {tree.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing here yet</EmptyTitle>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid divide-y divide-border">
          {tree.map(({ root, replies }) => (
            <div key={root.id} className="grid">
              <MessageRow message={root} you={root.author.toLowerCase() === me} onReply={setReplyTo} onDraft={draft} />
              {replies.map((reply) => (
                <MessageRow
                  key={reply.id}
                  message={reply}
                  you={reply.author.toLowerCase() === me}
                  reply
                  onDraft={draft}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <Composer
        subject={subject}
        body={body}
        onBodyChange={setBody}
        draftRevision={draftRevision}
        viewer={page?.viewer ?? null}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </div>
  )
}
