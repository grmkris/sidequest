import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { LoadingRows, Section } from '../components/kit.tsx'
import { When } from '../components/Time.tsx'
import { Monogram, useAuth } from '../components/Wallet.tsx'
import { Composer, useComposerPost } from '../components/commons/Composer.tsx'
import { BadgeList, MessageRow, PostBody } from '../components/commons/MessageRow.tsx'
import { useLinkedPost, useWriting } from '../components/commons/thread-state.ts'
import { LOBBY, type Message, composerGuidance, hiddenLabel, shortAddress, threadTree } from '../commons.ts'
import { postParts } from '../commons-post.ts'
import { usePostPage } from '../commons-query.ts'

/** A lobby post on its own page, to share or come back to: the post in full, every reply, and a reply of your own. */
export function CommonsPostPage() {
  // SAFETY: the route is /commons/post/$postId, so postId is always present.
  const { postId } = useParams({ strict: false }) as { postId: string }
  return <PostThread key={postId} id={Number(postId)} />
}

const back = (
  <Link to="/commons" className="inline-flex items-center gap-1 text-ui text-muted-foreground">
    <ArrowLeft aria-hidden className="size-4" />
    Lobby
  </Link>
)

function PostThread({ id }: { id: number }) {
  const auth = useAuth()
  const page = usePostPage(LOBBY, id)
  const tree = threadTree(page.data?.messages ?? [])
  const entry = tree.find(({ root }) => root.id === id)
  const state = useWriting(tree)
  // Everything written here answers the post.
  const replyTo = state.writing.replyTo ?? entry?.root ?? null
  const posting = useComposerPost({ subject: LOBBY, body: state.writing.body, replyTo, onPosted: state.posted })
  useLinkedPost(page.data?.messages, state)
  if (page.isLoading)
    return (
      <>
        {back}
        <LoadingRows rows={4} />
      </>
    )
  if (page.error !== null || entry === undefined || entry.root.replyTo !== null)
    return (
      <>
        {back}
        <Alert variant="destructive">
          <AlertDescription>
            {page.error === null ? (
              <Missing reply={entry?.root} />
            ) : (
              `This post could not be read: ${page.error.message}`
            )}
          </AlertDescription>
        </Alert>
      </>
    )
  const viewer = page.data?.viewer ?? null
  const canCompose = !(auth.signedIn && viewer !== null && composerGuidance(viewer, auth.signedIn) !== null)
  const me = auth.address?.toLowerCase()
  const { root, replies } = entry
  const n = replies.length
  return (
    <>
      {back}
      <Post message={root} you={root.author.toLowerCase() === me} {...(canCompose ? { onDraft: state.draft } : {})} />
      <Section title={n === 0 ? 'No replies yet' : `${n} ${n === 1 ? 'reply' : 'replies'}`}>
        <div className="grid min-w-0">
          {replies.map((reply) => (
            <MessageRow
              key={reply.id}
              message={reply}
              you={reply.author.toLowerCase() === me}
              reply
              {...(canCompose ? { onDraft: state.draft } : {})}
            />
          ))}
        </div>
        {root.hidden === null && (
          <div className="pt-2">
            <Composer
              posting={posting}
              body={state.writing.body}
              onBodyChange={state.setBody}
              draftRevision={state.writing.revision}
              viewer={viewer}
              replyTo={replyTo}
              onCancelReply={() => state.setReplyTo(null)}
              compact
              replyContext={false}
              placeholder="Reply to this post"
            />
          </div>
        )}
      </Section>
    </>
  )
}

/** Why there is no post to show: the number names a reply (with a way to the post it answers), or nothing at all. */
function Missing({ reply }: { reply: Message | undefined }) {
  if (reply?.replyTo == null) return <>There is no lobby post with this number.</>
  return (
    <>
      This is a reply.{' '}
      <Link
        to="/commons/post/$postId"
        params={{ postId: String(reply.replyTo) }}
        hash={`m${reply.id}`}
        className="underline underline-offset-4"
      >
        Open the post it answers
      </Link>
    </>
  )
}

/** The post: who wrote it and when, its title as the page's, then the rest of it in full. */
function Post({
  message,
  you,
  onDraft,
}: {
  message: Message
  you: boolean
  onDraft?: (message: Message, text: string) => void
}) {
  const parts = message.hidden === null && message.body !== null ? postParts(message.body) : null
  const quote = onDraft === undefined ? {} : { onDraft: (_: Message, text: string) => onDraft(message, text) }
  return (
    <article id={`m${message.id}`} className="grid min-w-0 scroll-mt-24 gap-4">
      <header className="grid gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui text-muted-foreground">
          <Monogram seed={message.author} size="md" />
          <span className="font-mono text-foreground">{shortAddress(message.author)}</span>
          {you && <Badge variant="info">You</Badge>}
          <BadgeList badges={message.badges} />
          <span className="ms-auto text-micro tabular-nums">
            <When at={message.createdAt} show="relative" />
          </span>
        </div>
        <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] min-w-0 text-pretty">
          {parts?.titled === true ? parts.title : `Post #${message.id}`}
        </h1>
      </header>
      {parts === null ? (
        <p className="text-muted-foreground italic">
          {message.hidden === null ? 'Hidden.' : hiddenLabel(message.hidden)}
        </p>
      ) : (
        <PostBody message={parts.titled ? { ...message, body: parts.rest } : message} full {...quote} />
      )}
    </article>
  )
}
