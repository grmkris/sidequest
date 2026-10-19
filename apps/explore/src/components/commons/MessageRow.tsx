import { ChevronDown, Reply } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { EnhancementFallback } from './EnhancementFallback.tsx'
import { cn } from '../../lib/cn.ts'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { When } from '../Time.tsx'
import { Monogram } from '../Wallet.tsx'
import { type Badge as BadgeT, type Message, hiddenLabel, shortAddress, shownBadges } from '../../commons.ts'
const MessageContent = lazy(() => import('./MessageContent.tsx'))

/** Who someone is in this thread, as the board snapshotted it when they posted: roles first, then stake. */
export function BadgeList({ badges }: { badges: readonly BadgeT[] }) {
  if (badges.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shownBadges(badges).map((badge) => (
        <Badge key={badge.key} variant={badge.role ? 'info' : 'neutral'} title={badge.title}>
          {badge.label}
        </Badge>
      ))}
    </span>
  )
}

/**
 * One post: the author's mark beside it, who they are (short address and badges) and when, then its Markdown. A long
 * post shows its opening until it is asked for in full. A hidden post keeps its place and author and shows the role and
 * reason instead of the text. Under a post: its replies' count, and Reply.
 */
export function MessageRow({
  message,
  you,
  onReply,
  onDraft,
  reply = false,
  replies,
}: {
  message: Message
  you: boolean
  onReply?: (message: Message) => void
  onDraft?: (message: Message, text: string) => void
  reply?: boolean
  /** The control that opens this post's replies. */
  replies?: ReactNode
}) {
  const canReply = onReply !== undefined && message.hidden === null
  return (
    <article
      id={`m${message.id}`}
      className={cn(
        'grid min-w-0 scroll-mt-24',
        reply
          ? 'gap-x-2.5 py-3 sm:grid-cols-[1.5rem_minmax(0,1fr)]'
          : 'gap-x-3 pt-5 pb-1 sm:grid-cols-[2.25rem_minmax(0,1fr)]',
      )}
      aria-label={`Post by ${shortAddress(message.author)}`}
    >
      {/* The author's mark heads its own column on a wide screen, and sits in the byline on a phone. */}
      <span className="hidden sm:block">
        <Monogram seed={message.author} size={reply ? 'sm' : 'md'} />
      </span>
      <div className="grid min-w-0 gap-1.5">
        <header
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui',
            reply ? 'min-h-6' : 'min-h-6 sm:min-h-9',
          )}
        >
          <span className="sm:hidden">
            <Monogram seed={message.author} />
          </span>
          <span className="font-mono text-foreground">{shortAddress(message.author)}</span>
          {you && <Badge variant="info">You</Badge>}
          <BadgeList badges={message.badges} />
          <span className="ml-auto text-micro text-muted-foreground tabular-nums">
            <When at={message.createdAt} show="relative" />
          </span>
        </header>
        {message.hidden !== null || message.body === null ? (
          <p className="text-sm text-muted-foreground italic">
            {message.hidden === null ? 'Hidden.' : hiddenLabel(message.hidden)}
          </p>
        ) : (
          <PostBody message={message} {...(onDraft === undefined ? {} : { onDraft })} />
        )}
        {(replies !== undefined || canReply) && (
          <div className="-ms-2.5 flex flex-wrap items-center gap-1 pt-0.5">
            {replies}
            {canReply && (
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
          </div>
        )}
      </div>
    </article>
  )
}

/** A post's Markdown and plan; `full` never cuts a long one to its opening. */
export function PostBody({
  message,
  onDraft,
  full = false,
}: {
  message: Message
  onDraft?: (message: Message, text: string) => void
  full?: boolean
}) {
  const plain = <div className="commons-markdown whitespace-pre-line">{message.body}</div>
  const content = (
    <EnhancementFallback fallback={plain}>
      <Suspense fallback={plain}>
        <MessageContent message={message} {...(onDraft === undefined ? {} : { onDraft })} />
      </Suspense>
    </EnhancementFallback>
  )
  // An interactive plan is never cut: its choices must stay reachable.
  return full || (message.presentation !== undefined && message.presentation !== null) ? (
    content
  ) : (
    <Opening>{content}</Opening>
  )
}

/** How much of a long post shows before "Show more", and how much longer it must be to be cut at all. */
const OPENING_REM = 16
const CUT_RATIO = 1.4

/** The first lines of a long post, fading out above "Show more"; a post only a little longer shows in full. */
function Opening({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const element = inner.current
    if (element === null || full) return
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      setLong(element.offsetHeight > OPENING_REM * CUT_RATIO * rem)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [full])
  const cut = long && !full
  return (
    <>
      <div className={cn('min-w-0', cut && 'post-opening')}>
        <div ref={inner} className="min-w-0">
          {children}
        </div>
      </div>
      {cut && (
        <div>
          <Button
            variant="link"
            className="h-auto min-h-8 px-0 font-medium pointer-coarse:min-h-11"
            onClick={() => setFull(true)}
          >
            Show more
          </Button>
        </div>
      )}
    </>
  )
}

/** A post's replies, folded: who replied, how many, and a chevron that turns when they open below. */
export function RepliesToggle({
  replies,
  expanded,
  onToggle,
  controls,
}: {
  replies: readonly Message[]
  expanded: boolean
  onToggle: () => void
  controls: string
}) {
  const authors = [...new Set(replies.map((r) => r.author.toLowerCase()))].slice(0, 3)
  const n = replies.length
  return (
    <Button
      variant="ghost"
      size="sm"
      className="min-h-10 gap-2 font-medium pointer-coarse:min-h-11"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span aria-hidden className="flex -space-x-2">
        {authors.map((author) => (
          <span key={author} className="rounded-full ring-2 ring-background">
            <Monogram seed={author} />
          </span>
        ))}
      </span>
      <span className="tabular-nums">
        {n} {n === 1 ? 'reply' : 'replies'}
      </span>
      <ChevronDown
        aria-hidden
        className={cn('transition-transform duration-(--dur-fast) ease-(--ease-out-strong)', expanded && 'rotate-180')}
      />
    </Button>
  )
}

/** A post's replies on a thread line from its author's mark, and the composer when answering it. */
export function Replies({
  id,
  replies,
  me,
  onDraft,
  children,
  className,
}: {
  id: string
  className?: string
  replies: readonly Message[]
  me: string | undefined
  onDraft?: (message: Message, text: string) => void
  children?: ReactNode
}) {
  return (
    <div
      id={id}
      className={cn(
        'ms-3 mb-4 grid min-w-0 animate-[view-in_var(--dur-base)_var(--ease-out-strong)] border-s-2 border-border ps-4 motion-reduce:animate-none sm:ms-[17px] sm:ps-[29px]',
        className,
      )}
    >
      {replies.map((reply) => (
        <MessageRow
          key={reply.id}
          message={reply}
          you={reply.author.toLowerCase() === me}
          reply
          {...(onDraft === undefined ? {} : { onDraft })}
        />
      ))}
      {children !== undefined && children !== false && <div className="py-1">{children}</div>}
    </div>
  )
}
