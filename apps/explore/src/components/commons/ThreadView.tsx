import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { LoadingRows } from '../kit.tsx'
import { useAuth } from '../Wallet.tsx'
import { type Message, composerGuidance, threadTree } from '../../commons.ts'
import { acknowledgeDraft } from '../../commons-app/draft.ts'
import { useThread } from '../../commons-query.ts'
import { Composer } from './Composer.tsx'
import { MessageRow } from './MessageRow.tsx'

/**
 * A thread, newest page in order of posting with replies under their post, and the composer under it. It polls every
 * 10 s, so a reply from an agent shows up without a reload.
 */
interface ThreadProps {
  subject: string
  empty: string
  placeholder?: string
}

export function ThreadView(props: ThreadProps) {
  return <ThreadContent key={props.subject} {...props} />
}

function ThreadContent({ subject, empty, placeholder }: ThreadProps) {
  const auth = useAuth()
  const thread = useThread(subject)
  const [writing, setWriting] = useState({ body: '', replyTo: null as Message | null, revision: 0 })
  const { body, replyTo, revision: draftRevision } = writing
  const setReplyTo = (replyTo: Message | null) => setWriting((current) => ({ ...current, replyTo }))
  const draft = (message: Message, text: string) => {
    setWriting((current) => ({
      body: current.body.trim() === '' ? text : `${current.body}\n\n${text}`,
      replyTo: message,
      revision: current.revision + 1,
    }))
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
  const viewer = page?.viewer ?? null
  const canCompose = !(auth.signedIn && viewer !== null && composerGuidance(viewer, auth.signedIn) !== null)
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
              <MessageRow
                message={root}
                you={root.author.toLowerCase() === me}
                {...(canCompose ? { onReply: setReplyTo, onDraft: draft } : {})}
              />
              {replies.map((reply) => (
                <MessageRow
                  key={reply.id}
                  message={reply}
                  you={reply.author.toLowerCase() === me}
                  reply
                  {...(canCompose ? { onDraft: draft } : {})}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <Composer
        subject={subject}
        body={body}
        onBodyChange={(body) => setWriting((current) => ({ ...current, body }))}
        draftRevision={draftRevision}
        viewer={page?.viewer ?? null}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onPosted={(submittedBody, submittedReplyTo) => {
          setWriting((current) => {
            const body = acknowledgeDraft(current.body, submittedBody)
            const clearReply = body === '' && current.replyTo?.id === submittedReplyTo
            return { ...current, body, replyTo: clearReply ? null : current.replyTo }
          })
        }}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </div>
  )
}
