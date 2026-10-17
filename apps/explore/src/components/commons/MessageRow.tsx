import { Reply } from 'lucide-react'
import { CommonsPresentation } from '@sidequest/react/commons-ui'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { When } from '../Time.tsx'
import { Monogram } from '../Wallet.tsx'
import { type Badge as BadgeT, type Message, hiddenLabel, shortAddress, shownBadges } from '../../commons.ts'
import { Markdown } from './Markdown.tsx'

/** Who someone is in this thread, as the board snapshotted it when they posted: roles first, then stake. */
function BadgeList({ badges }: { badges: readonly BadgeT[] }) {
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
 * One post: who wrote it (their mark, short address and badges), when, and its Markdown. A hidden post keeps
 * its place and author and shows the role and reason instead of the text.
 */
export function MessageRow({
  message,
  you,
  onReply,
  onDraft,
  reply = false,
}: {
  message: Message
  you: boolean
  onReply?: (message: Message) => void
  onDraft?: (message: Message, text: string) => void
  reply?: boolean
}) {
  return (
    <article
      id={`m${message.id}`}
      className={reply ? 'ms-4 grid min-w-0 gap-3 border-s-2 border-border py-3 ps-4' : 'grid min-w-0 gap-3 py-5'}
      aria-label={`Post by ${shortAddress(message.author)}`}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui">
        <Monogram seed={message.author} />
        <span className="font-mono text-muted-foreground">{shortAddress(message.author)}</span>
        {you && <Badge variant="info">You</Badge>}
        <BadgeList badges={message.badges} />
        <span className="ml-auto text-micro text-muted-foreground">
          <When at={message.createdAt} show="relative" />
        </span>
      </header>
      {message.hidden !== null || message.body === null ? (
        <p className="text-sm text-muted-foreground italic">
          {message.hidden === null ? 'Hidden.' : hiddenLabel(message.hidden)}
        </p>
      ) : (
        <>
          <Markdown>{message.body}</Markdown>
          {message.presentation !== undefined && message.presentation !== null && (
            <CommonsPresentation
              value={message.presentation}
              {...(onDraft === undefined ? {} : { onDraft: (text: string) => onDraft(message, text) })}
            />
          )}
        </>
      )}
      {onReply !== undefined && message.hidden === null && (
        <div>
          <Button variant="ghost" size="sm" className="min-h-10" onClick={() => onReply(message)}>
            <Reply aria-hidden />
            Reply
          </Button>
        </div>
      )}
    </article>
  )
}
