/**
 * What a thread view remembers while someone reads and writes in it: the draft and what it answers, which posts are
 * open in full, and which have their replies open. Shared by the thread, the lobby's rows and a post's own page.
 */
import { type ReactNode, useEffect, useState } from 'react'
import { type Message, threadTree } from '../../commons.ts'
import { acknowledgeDraft, quoteCommonsDraft } from '../../commons-app/draft.ts'

type Tree = ReturnType<typeof threadTree>

interface Writing {
  body: string
  replyTo: Message | null
  revision: number
}

/** The post a message belongs under: itself for a post, the post it answers for a reply. */
export const rootIn = (tree: Tree, message: Message) =>
  tree.find(({ root, replies }) => root.id === message.id || replies.some((r) => r.id === message.id))?.root.id

/** The message a `#m53` link names. */
function linkedId(): number | null {
  const match = /^#m(\d+)$/.exec(globalThis.location?.hash ?? '')
  return match === null ? null : Number(match[1])
}

const including = (set: ReadonlySet<number>, id: number) => new Set(set).add(id)
function flipped(set: ReadonlySet<number>, id: number) {
  const next = new Set(set)
  if (!next.delete(id)) next.add(id)
  return next
}

/** The draft, what it answers, which posts are open in full (`shown`) and which have their replies open (`open`). */
export function useWriting(tree: Tree) {
  const [writing, setWriting] = useState<Writing>({ body: '', replyTo: null, revision: 0 })
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set())
  const openRoot = (root: number) => setOpen((current) => including(current, root))
  const show = (root: number) => setShown((current) => including(current, root))
  const openUnder = (message: Message) => {
    const root = rootIn(tree, message)
    if (root !== undefined) openRoot(root)
  }
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
  return {
    writing,
    open,
    shown,
    openRoot,
    show,
    toggle: (root: number) => setOpen((current) => flipped(current, root)),
    toggleShown: (root: number) => setShown((current) => flipped(current, root)),
    setReplyTo,
    draft,
    setBody,
    posted,
  }
}

/**
 * A link to a post (`#m51`) opens it, and a link to a reply (`#m53`) opens the post it answers with its replies, once
 * the thread is read; then the page scrolls to it.
 */
export function useLinkedPost(
  messages: readonly Message[] | undefined,
  { show, openRoot }: { show: (root: number) => void; openRoot: (root: number) => void },
) {
  const loaded = messages !== undefined
  useEffect(() => {
    const id = linkedId()
    const linked = id === null ? undefined : messages?.find((m) => m.id === id)
    if (linked === undefined) return
    show(linked.replyTo ?? linked.id)
    if (linked.replyTo !== null) openRoot(linked.replyTo)
    requestAnimationFrame(() => document.getElementById(`m${linked.id}`)?.scrollIntoView({ block: 'start' }))
  }, [loaded])
}

/** What every way of listing a thread's posts is given. */
export interface PostsProps {
  tree: Tree
  open: ReadonlySet<number>
  onToggle: (root: number) => void
  replyRoot: number | undefined
  composer: ReactNode
  me: string | undefined
  onReply?: (message: Message) => void
  onDraft?: (message: Message, text: string) => void
}
