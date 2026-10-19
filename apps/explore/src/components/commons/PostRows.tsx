import { Link } from '@tanstack/react-router'
import { MessageSquare, Reply } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { Badge } from '../ui/badge.tsx'
import { Button, buttonVariants } from '../ui/button.tsx'
import { When } from '../Time.tsx'
import { Monogram } from '../Wallet.tsx'
import { type Message, hiddenLabel, shortAddress } from '../../commons.ts'
import { postParts, postRow } from '../../commons-post.ts'
import { BadgeList, PostBody, Replies, RepliesToggle } from './MessageRow.tsx'
import type { PostsProps } from './thread-state.ts'

/**
 * The lobby as a list: each post one row with its title, a line or two of what it says, who wrote it, how many
 * replied and when. A row opens in place, lifted onto a card, into the whole post with its replies and Reply; its own
 * page (`pages`) is one more click.
 */
export function PostRows({
  tree,
  open,
  onToggle,
  replyRoot,
  composer,
  me,
  onReply,
  onDraft,
  shown,
  onShow,
  pages,
}: PostsProps & { shown: ReadonlySet<number>; onShow: (root: number) => void; pages: boolean }) {
  return (
    <ol className="-mx-3 grid gap-1" aria-label="Posts">
      {tree.map(({ root, replies }) => {
        const answering = replyRoot === root.id
        return (
          <li key={root.id} className="min-w-0">
            <PostRow
              message={root}
              replies={replies}
              me={me}
              shown={shown.has(root.id) || answering}
              onShow={() => onShow(root.id)}
              repliesOpen={open.has(root.id) || answering}
              onToggleReplies={() => onToggle(root.id)}
              page={pages}
              {...(onReply === undefined ? {} : { onReply })}
              {...(onDraft === undefined ? {} : { onDraft })}
            >
              {answering && composer}
            </PostRow>
          </li>
        )
      })}
    </ol>
  )
}

interface RowProps {
  message: Message
  replies: readonly Message[]
  me: string | undefined
  shown: boolean
  onShow: () => void
  repliesOpen: boolean
  onToggleReplies: () => void
  page: boolean
  onReply?: (message: Message) => void
  onDraft?: (message: Message, text: string) => void
  /** The composer, while a reply to this post is being written. */
  children?: ReactNode
}

function PostRow(props: RowProps) {
  const { message, replies, shown } = props
  const visible = message.hidden === null && message.body !== null
  return (
    <article
      id={`m${message.id}`}
      aria-label={`Post by ${shortAddress(message.author)}`}
      className={cn(
        'grid min-w-0 scroll-mt-24 rounded-2xl transition-[background-color,box-shadow] duration-(--dur-base) ease-(--ease-out-strong)',
        shown && 'my-2 bg-card shadow-chip',
      )}
    >
      {visible || replies.length > 0 ? (
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={`p${message.id}`}
          onClick={props.onShow}
          className={cn(
            'rounded-2xl text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            !shown && 'transition-colors duration-(--dur-fast) active:bg-muted [@media(hover:hover)]:hover:bg-muted/60',
          )}
        >
          <RowHead {...props} visible={visible} />
        </button>
      ) : (
        <RowHead {...props} visible={visible} />
      )}
      {shown && <RowBody {...props} visible={visible} />}
    </article>
  )
}

/** The row itself: the author's mark, then the title and summary, then who wrote it, the replies and when. */
function RowHead({ message, replies, me, shown, visible }: RowProps & { visible: boolean }) {
  const row =
    visible && message.body !== null
      ? postRow(message.body)
      : { title: null, summary: message.hidden === null ? 'Hidden.' : hiddenLabel(message.hidden) }
  // Read in full below, an untitled post's text is not repeated here.
  const summary = shown && visible ? null : row.summary
  return (
    <span className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 px-3 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)]">
      <span className="sm:hidden">
        <Monogram seed={message.author} />
      </span>
      <span className="hidden sm:block">
        <Monogram seed={message.author} size="md" />
      </span>
      <span className="grid min-w-0 gap-1">
        {row.title !== null && (
          <span className={cn('font-medium text-pretty text-foreground', !shown && 'line-clamp-2 sm:line-clamp-1')}>
            {row.title}
          </span>
        )}
        {summary !== null && summary !== '' && (
          <span
            className={cn(
              'text-sm text-pretty',
              !visible && 'text-muted-foreground italic',
              visible && row.title !== null && 'line-clamp-2 text-muted-foreground',
              visible && row.title === null && 'line-clamp-3 text-foreground',
            )}
          >
            {summary}
          </span>
        )}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-ui text-muted-foreground">
          <span className="font-mono">{shortAddress(message.author)}</span>
          {message.author.toLowerCase() === me && <Badge variant="info">You</Badge>}
          <BadgeList badges={message.badges} />
          <span className="ms-auto flex items-center gap-3 tabular-nums">
            {replies.length > 0 && !shown && (
              <span className="flex items-center gap-1" aria-label={`${replies.length} replies`}>
                <MessageSquare aria-hidden className="size-3.5" />
                {replies.length}
              </span>
            )}
            <span className="text-micro">
              <When at={message.createdAt} show="relative" />
            </span>
          </span>
        </span>
      </span>
    </span>
  )
}

/** The opened row: the post in full, under its title, then its replies, Reply and its own page. */
function RowBody({
  message,
  replies,
  me,
  repliesOpen,
  onToggleReplies,
  page,
  onReply,
  onDraft,
  children,
  visible,
}: RowProps & { visible: boolean }) {
  const quote = onDraft === undefined ? {} : { onDraft: (_: Message, text: string) => onDraft(message, text) }
  const rest = visible && message.body !== null ? postParts(message.body) : null
  return (
    <div
      id={`p${message.id}`}
      className="grid min-w-0 animate-[view-in_var(--dur-base)_var(--ease-out-strong)] gap-3 ps-12 pe-3 pb-3 motion-reduce:animate-none sm:ps-[3.75rem]"
    >
      {rest !== null && <PostBody message={rest.titled ? { ...message, body: rest.rest } : message} full {...quote} />}
      <div className="-ms-2.5 flex flex-wrap items-center gap-1">
        {replies.length > 0 && (
          <RepliesToggle
            replies={replies}
            expanded={repliesOpen}
            onToggle={onToggleReplies}
            controls={`r${message.id}`}
          />
        )}
        {onReply !== undefined && visible && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-10 text-muted-foreground pointer-coarse:min-h-11"
            onClick={() => onReply(message)}
          >
            <Reply aria-hidden />
            Reply
          </Button>
        )}
        {page && (
          <Link
            to="/commons/post/$postId"
            params={{ postId: String(message.id) }}
            className={buttonVariants({
              variant: 'ghost',
              size: 'sm',
              className: 'ms-auto min-h-10 text-muted-foreground pointer-coarse:min-h-11',
            })}
          >
            Open post
          </Link>
        )}
      </div>
      {repliesOpen && (
        <Replies
          id={`r${message.id}`}
          replies={replies}
          me={me}
          className="ms-0 mb-0 ps-4 sm:ms-0 sm:ps-5"
          {...(onDraft === undefined ? {} : { onDraft })}
        >
          {children}
        </Replies>
      )}
    </div>
  )
}
