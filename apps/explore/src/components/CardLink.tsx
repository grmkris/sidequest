import {
  type MouseEvent,
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { buttonVariants } from './ui/button.tsx'
import { cn } from '../lib/cn.ts'
import { BoardLink, type LinkTarget } from './BoardLink.tsx'
import { Sheet } from './Sheet.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'

/** Wide enough for a card beside its link; narrower, the card is a bottom sheet. Sheet.tsx draws the same line. */
const WIDE = '(min-width: 640px)'

function subscribe(change: () => void) {
  const query = window.matchMedia(WIDE)
  query.addEventListener('change', change)
  return () => query.removeEventListener('change', change)
}

/** Whether the screen is wide; true where nothing can measure it (server rendering, tests). */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => true,
  )
}

/** What an open card knows of where it shows: in a sheet, whose title already names it, and how to close it. */
interface CardFrame {
  inSheet: boolean
  close: () => void
}

const Frame = createContext<CardFrame>({ inSheet: false, close: () => undefined })

/** The card's frame, for a card that leaves out what its sheet's title says, or closes itself after an action. */
export const useCardFrame = () => useContext(Frame)

/** A click that goes straight to the page, as any link's would: with a modifier key, or not the main button. */
export const followsLink = (e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button'>): boolean =>
  e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0

/**
 * A link that opens a card about where it goes. A press opens the card: anchored to the link on a wide screen, a bottom
 * sheet on a phone. The card's main link (`CardAction`) goes to the page; a modified or middle click goes straight
 * there, as a link's would. The card mounts on first open, so whatever it reads starts on demand. A `decorative` link
 * (an orb beside the name that opens the same card) stays out of the tab order and the accessibility tree.
 */
export function CardLink({
  target,
  title,
  card,
  className,
  label,
  decorative = false,
  alignOffset = 0,
  mode = 'auto',
  children,
}: {
  target: LinkTarget
  /** The sheet's title on a phone: the name the card is about. */
  title: ReactNode
  card: ReactNode
  className?: string
  /** The link's accessible name, when its content does not say it. */
  label?: string
  decorative?: boolean
  /** How far from the link's start edge the card lines up, in px. */
  alignOffset?: number
  mode?: 'auto' | 'sheet'
  children?: ReactNode
}) {
  const wideScreen = useWide()
  const wide = mode !== 'sheet' && wideScreen
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)
  const show = (next: boolean) => {
    setOpen(next)
    if (next) setShown(true)
  }
  const frame = useMemo(() => ({ inSheet: !wide, close: () => setOpen(false) }), [wide])
  const link = {
    ...(decorative ? { tabIndex: -1, 'aria-hidden': true } : {}),
    ...(label === undefined ? {} : { 'aria-label': label }),
    className,
  }
  const body = <Frame value={frame}>{card}</Frame>
  if (!wide)
    return (
      <>
        <BoardLink
          target={target}
          {...link}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(e) => {
            if (followsLink(e)) return
            e.preventDefault()
            show(true)
          }}
        >
          {children}
        </BoardLink>
        {/* The sheet lives at the page's root: a link inside a sentence cannot hold a dialog. */}
        {shown &&
          createPortal(
            <Sheet open={open} onClose={() => setOpen(false)} title={title} className="gap-3">
              {body}
            </Sheet>,
            document.body,
          )}
      </>
    )
  return (
    <Popover open={open} onOpenChange={show}>
      <PopoverTrigger
        nativeButton={false}
        render={<BoardLink target={target} {...link} />}
        onClick={(e) => {
          // The browser opens the page (a new tab, a window); the card stays shut.
          if (followsLink(e)) e.preventBaseUIHandler()
          else e.preventDefault()
        }}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent size="card" align="start" alignOffset={alignOffset} sideOffset={6}>
        {body}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A card's one main link, to the page it previews: across the foot of the card, a full-width button in a sheet. It
 * closes the card, since the page it opens may keep the card's link on screen.
 */
export function CardAction({ target, children }: { target: LinkTarget; children: ReactNode }) {
  const { inSheet, close } = useCardFrame()
  return (
    <BoardLink
      target={target}
      onClick={(e) => {
        if (!followsLink(e)) close()
      }}
      className={cn(
        buttonVariants({ variant: 'secondary', size: inSheet ? 'lg' : 'sm' }),
        inSheet ? 'w-full' : 'shrink-0',
      )}
    >
      {children}
    </BoardLink>
  )
}
