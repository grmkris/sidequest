import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { LoadingRows } from '../kit.tsx'
import { useAuth } from '../Wallet.tsx'
import { LOBBY, composerGuidance, threadTree } from '../../commons.ts'
import { useThread } from '../../commons-query.ts'
import { Composer, useComposerPost } from './Composer.tsx'
import { MessageRow, Replies, RepliesToggle } from './MessageRow.tsx'
import { PostRows } from './PostRows.tsx'
import { type PostsProps, rootIn, useLinkedPost, useWriting } from './thread-state.ts'

/**
 * A thread. Each post shows how many replies it has; they open under it on demand, and the composer for a reply opens
 * there too. `newest` reads as a feed: the composer on top, the latest post first. `oldest` reads as a conversation (a
 * job's thread): the first post first, the composer under them. `rows` (the lobby) lists each post as a title and a
 * summary that opens in place, with its own page a click further. It polls every 10 s, so a reply from an agent shows
 * up without a reload.
 */
interface ThreadProps {
  subject: string
  empty: string
  placeholder?: string
  order?: 'oldest' | 'newest'
  variant?: 'posts' | 'rows'
  /** A line under the composer: who reads the thread. */
  note?: string
}

export function ThreadView(props: ThreadProps) {
  return <ThreadContent key={props.subject} {...props} />
}

function ThreadContent({ subject, empty, placeholder, order = 'oldest', variant = 'posts', note }: ThreadProps) {
  const auth = useAuth()
  const thread = useThread(subject)
  const tree = threadTree(thread.data?.messages ?? [], order)
  const state = useWriting(tree)
  const { writing, setReplyTo, draft, setBody, posted } = state
  const posting = useComposerPost({ subject, body: writing.body, replyTo: writing.replyTo, onPosted: posted })
  useLinkedPost(thread.data?.messages, state)
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
  const posts = {
    tree,
    open: state.open,
    onToggle: state.toggle,
    replyRoot,
    composer,
    me: auth.address?.toLowerCase(),
    ...(canCompose ? { onReply: setReplyTo, onDraft: draft } : {}),
  }
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
      ) : variant === 'rows' ? (
        <PostRows {...posts} shown={state.shown} onShow={state.toggleShown} pages={subject === LOBBY} />
      ) : (
        <ThreadPosts {...posts} />
      )}
      {free && order === 'oldest' && start}
    </div>
  )
}

/** The posts in full, each with its replies folded under a count, open where asked or where a reply is being written. */
function ThreadPosts({ tree, open, onToggle, replyRoot, composer, me, onReply, onDraft }: PostsProps) {
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
              <Replies id={`r${root.id}`} replies={replies} me={me} {...drafting}>
                {replyRoot === root.id && composer}
              </Replies>
            )}
          </li>
        )
      })}
    </ol>
  )
}
