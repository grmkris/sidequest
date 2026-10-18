import { type ReactNode, useEffect, useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { LoadingRows } from '../kit.tsx'
import { useAuth } from '../Wallet.tsx'
import { type Message, composerGuidance, threadTree } from '../../commons.ts'
import { acknowledgeDraft, quoteCommonsDraft } from '../../commons-app/draft.ts'
import { useThread } from '../../commons-query.ts'
import { Composer, useComposerPost } from './Composer.tsx'
import { MessageRow, RepliesToggle } from './MessageRow.tsx'

/**
 * A thread. Each post shows how many replies it has; they open under it on demand, and the composer for a reply opens
 * there too. `newest` reads as a feed (the lobby): the composer on top, the latest post first. `oldest` reads as a
 * conversation (a job's thread): the first post first, the composer under them. It polls every 10 s, so a reply from an
 * agent shows up without a reload.
 */
interface Writing {
  body: string
  replyTo: Message | null
  revision: number
}

type Tree = ReturnType<typeof threadTree>

interface ThreadProps {
  subject: string
  empty: string
  placeholder?: string
  order?: 'oldest' | 'newest'
  /** A line under the composer: who reads the thread. */
  note?: string
}

export function ThreadView(props: ThreadProps) {
  return <ThreadContent key={props.subject} {...props} />
}

/** The post a message belongs under: itself for a post, the post it answers for a reply. */
const rootIn = (tree: Tree, message: Message) =>
  tree.find(({ root, replies }) => root.id === message.id || replies.some((r) => r.id === message.id))?.root.id

/** The message a `#m53` link names. */
function linkedId(): number | null {
  const match = /^#m(\d+)$/.exec(globalThis.location?.hash ?? '')
  return match === null ? null : Number(match[1])
}

/** The draft, what it answers, and which posts have their replies open. */
function useWriting(tree: Tree) {
  const [writing, setWriting] = useState<Writing>({ body: '', replyTo: null, revision: 0 })
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const openRoot = (root: number) => setOpen((current) => new Set(current).add(root))
  const openUnder = (message: Message) => {
    const root = rootIn(tree, message)
    if (root !== undefined) openRoot(root)
  }
  const toggle = (root: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(root)) next.add(root)
      return next
    })
  const setReplyTo = (replyTo: Message | null) => {
    if (replyTo !== null) openUnder(replyTo)
    setWriting((current) => ({ ...current, replyTo }))
  }
  const draft = (message: Message, text: string) => {
    openUnder(message)
    const quote = quoteCommonsDraft(message, text)
    setWriting((current) => ({
      body: current.body.trim() === '' ? quote : `${current.body}\n\n${quote}`,
      replyTo: message,
      revision: current.revision + 1,
    }))
  }
  const setBody = (body: string) => setWriting((current) => ({ ...current, body }))
  const posted = (submittedBody: string, submittedReplyTo: number | null) =>
    setWriting((current) => {
      const body = acknowledgeDraft(current.body, submittedBody)
      const clearReply = body === '' && current.replyTo?.id === submittedReplyTo
      return { ...current, body, replyTo: clearReply ? null : current.replyTo }
    })
  return { writing, open, openRoot, toggle, setReplyTo, draft, setBody, posted }
}

/** A link to a reply opens the post it answers once the thread is read, then scrolls to it. */
function useLinkedReply(messages: readonly Message[] | undefined, openRoot: (root: number) => void) {
  const loaded = messages !== undefined
  useEffect(() => {
    const id = linkedId()
    const linked = id === null ? undefined : messages?.find((m) => m.id === id)
    if (linked === undefined) return
    if (linked.replyTo !== null) openRoot(linked.replyTo)
    requestAnimationFrame(() => document.getElementById(`m${linked.id}`)?.scrollIntoView({ block: 'start' }))
  }, [loaded])
}

function ThreadContent({ subject, empty, placeholder, order = 'oldest', note }: ThreadProps) {
  const auth = useAuth()
  const thread = useThread(subject)
  const tree = threadTree(thread.data?.messages ?? [], order)
  const { writing, open, openRoot, toggle, setReplyTo, draft, setBody, posted } = useWriting(tree)
  const posting = useComposerPost({ subject, body: writing.body, replyTo: writing.replyTo, onPosted: posted })
  useLinkedReply(thread.data?.messages, openRoot)
  if (thread.isLoading) return <LoadingRows rows={3} />
  if (thread.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>The thread could not be read: {thread.error.message}</AlertDescription>
      </Alert>
    )
  const viewer = thread.data?.viewer ?? null
  const canCompose = !(auth.signedIn && viewer !== null && composerGuidance(viewer, auth.signedIn) !== null)
  const replyRoot = writing.replyTo === null ? undefined : rootIn(tree, writing.replyTo)
  const composer = (
    <Composer
      posting={posting}
      body={writing.body}
      onBodyChange={setBody}
      draftRevision={writing.revision}
      viewer={viewer}
      replyTo={writing.replyTo}
      onCancelReply={() => setReplyTo(null)}
      compact={writing.replyTo === null}
      {...(placeholder === undefined ? {} : { placeholder })}
    />
  )
  // The composer sits under the post it answers; a new post is written where the feed starts or the conversation ends.
  const start = (
    <div className="grid gap-2">
      {composer}
      {note !== undefined && <p className="px-1 text-ui text-muted-foreground">{note}</p>}
    </div>
  )
  const free = replyRoot === undefined
  return (
    <div className="grid min-w-0 gap-4">
      {free && order === 'newest' && start}
      {tree.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing here yet</EmptyTitle>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ThreadPosts
          tree={tree}
          open={open}
          onToggle={toggle}
          replyRoot={replyRoot}
          composer={composer}
          me={auth.address?.toLowerCase()}
          {...(canCompose ? { onReply: setReplyTo, onDraft: draft } : {})}
        />
      )}
      {free && order === 'oldest' && start}
    </div>
  )
}

/** The posts, each with its replies folded under a count, open where asked or where a reply is being written. */
function ThreadPosts({
  tree,
  open,
  onToggle,
  replyRoot,
  composer,
  me,
  onReply,
  onDraft,
}: {
  tree: Tree
  open: ReadonlySet<number>
  onToggle: (root: number) => void
  replyRoot: number | undefined
  composer: ReactNode
  me: string | undefined
  onReply?: (message: Message) => void
  onDraft?: (message: Message, text: string) => void
}) {
  const drafting = onDraft === undefined ? {} : { onDraft }
  return (
    <ol className="grid divide-y divide-border" aria-label="Posts">
      {tree.map(({ root, replies }) => {
        const expanded = open.has(root.id) || replyRoot === root.id
        return (
          <li key={root.id} className="grid min-w-0 pb-1">
            <MessageRow
              message={root}
              you={root.author.toLowerCase() === me}
              {...(onReply === undefined ? {} : { onReply })}
              {...drafting}
              replies={
                replies.length === 0 ? undefined : (
                  <RepliesToggle
                    replies={replies}
                    expanded={expanded}
                    onToggle={() => onToggle(root.id)}
                    controls={`r${root.id}`}
                  />
                )
              }
            />
            {expanded && (
              // A thread line from the post's mark down its replies.
              <div
                id={`r${root.id}`}
                className="ms-3 mb-4 grid min-w-0 animate-[view-in_var(--dur-base)_var(--ease-out-strong)] border-s-2 border-border ps-4 motion-reduce:animate-none sm:ms-[17px] sm:ps-[29px]"
              >
                {replies.map((reply) => (
                  <MessageRow
                    key={reply.id}
                    message={reply}
                    you={reply.author.toLowerCase() === me}
                    reply
                    {...drafting}
                  />
                ))}
                {replyRoot === root.id && <div className="py-1">{composer}</div>}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
