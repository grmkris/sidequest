import { Button } from './ui/button.tsx'
import { cn } from '../lib/cn.ts'
/**
 * Sheets and toasts. A sheet is a native modal <dialog> (top layer, focus trapped, Escape closes, the page behind
 * is inert): a bottom sheet on a phone that follows the finger and is flicked away with momentum, a centred panel on
 * a wider screen. Decisions that move money go through `ConfirmSheet`, which says what will happen before it does.
 */
import { X } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

/** Apple's momentum projection: where a flick released at `velocity` px/s comes to rest. */
const project = (velocity: number, decelerationRate = 0.998) =>
  ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)

/**
 * `walletPrompt`: a wallet request started from the sheet is pending. An embedded wallet (Privy) draws its own prompt in
 * the page, which sits below the top layer and is inert behind a modal dialog, so its Sign button could not be pressed.
 * While one is pending the sheet stays on screen as a non-modal dialog, and nothing in it dismisses it: closing the sheet
 * would not cancel the request, which could still be confirmed after the review had gone.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
  walletPrompt = false,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  className?: string
  walletPrompt?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; y: number; t: number; v: number } | null>(null)
  const [dy, setDy] = useState(0)
  const titleId = useId()
  const dismiss = () => {
    if (!walletPrompt) onClose()
  }

  const modal = useRef(false)
  // Closing plays the panel's exit (down off a phone, a fade on a wider screen); the dialog closes when it ends.
  const [leaving, setLeaving] = useState(false)
  const finish = useCallback(() => {
    setLeaving(false)
    if (ref.current?.open === true) ref.current.close()
  }, [])

  useEffect(() => {
    const d = ref.current
    if (d === null) return
    if (!open) {
      if (d.open) setLeaving(true)
      return
    }
    setLeaving(false)
    const wantModal = !walletPrompt
    if (d.open && modal.current === wantModal) return
    if (d.open) d.close()
    else setDy(0)
    modal.current = wantModal
    if (wantModal) d.showModal()
    else d.show()
  }, [open, walletPrompt])

  // If the exit never reports its end (the tab hid, the panel never painted), close anyway.
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(finish, 400)
    return () => clearTimeout(t)
  }, [leaving, finish])

  const onPointerDown = (e: React.PointerEvent) => {
    if (window.matchMedia('(min-width: 640px)').matches) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { start: e.clientY, y: e.clientY, t: e.timeStamp, v: 0 }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current
    if (g === null) return
    const dt = Math.max(1, e.timeStamp - g.t)
    g.v = ((e.clientY - g.y) / dt) * 1000
    g.y = e.clientY
    g.t = e.timeStamp
    const offset = e.clientY - g.start
    // Upward past the resting point resists (rubber band); downward follows the finger 1:1.
    setDy(offset >= 0 ? offset : -Math.sqrt(-offset) * 2)
  }
  const onPointerUp = () => {
    const g = drag.current
    drag.current = null
    if (g === null) return
    const height = panel.current?.offsetHeight ?? 400
    const rest = g.y - g.start + project(g.v)
    // A flick that cannot dismiss (a wallet request is pending) springs back rather than leaving the sheet off screen.
    if (rest > height * 0.45 && !walletPrompt) onClose()
    else setDy(0)
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        // Switching between modal and non-modal closes and reopens the dialog; its queued close event is not a dismissal.
        if (ref.current?.open !== true) onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        dismiss()
      }}
      onClick={(e) => {
        // A click on the dialog itself (not its panel) is a click on the backdrop.
        if (e.target === ref.current) dismiss()
      }}
      data-leaving={leaving ? '' : undefined}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-overlay backdrop:transition-opacity backdrop:duration-(--dur-slow) data-leaving:backdrop:opacity-0 sm:open:grid sm:open:place-items-center"
    >
      <div
        ref={panel}
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) finish()
        }}
        style={{
          transform: dy === 0 ? undefined : `translateY(${dy}px)`,
          transition: drag.current === null ? undefined : 'none',
        }}
        className={cn(
          'absolute inset-x-0 bottom-0 grid max-h-[90vh] gap-4 overflow-y-auto rounded-t-xl bg-popover px-5 pt-2 pb-[calc(1.25rem+var(--safe-bottom))] text-sm text-popover-foreground shadow-popover',
          // A grouped block inside the sheet sits one step down, not white on white.
          '[&_.bg-card]:bg-muted/50',
          'animate-[sheet-in_0.42s_var(--ease-sheet)] transition-transform duration-300 ease-(--ease-sheet)',
          'sm:relative sm:inset-auto sm:w-[28rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-xl sm:px-5 sm:pt-4 sm:pb-5 sm:animate-[panel-in_0.24s_var(--ease-out-strong)]',
          // The exit is quicker than the entrance; from wherever a drag left the panel, it carries on down.
          leaving &&
            'pointer-events-none animate-[sheet-out_0.26s_var(--ease-sheet)_forwards] sm:animate-[panel-out_0.16s_var(--ease-out-strong)_forwards]',
          className,
        )}
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="-mx-5 cursor-grab touch-none px-5 pt-1 pb-1 sm:hidden"
        >
          <div className="mx-auto h-1 w-9 rounded-full bg-foreground/15" />
        </div>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="pt-1 text-base leading-snug font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={walletPrompt}
            onClick={dismiss}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground disabled:opacity-40 pointer-coarse:size-11"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

/**
 * "Approve and pay?": what will happen, then one clear confirm and a way out. `tone: 'destructive'` for actions that
 * take something away (reject, cancel, revoke).
 */
export function ConfirmSheet({
  open,
  onClose,
  title,
  description,
  children,
  confirm,
  onConfirm,
  tone = 'primary',
  busy,
  disabled,
  cancelLabel = 'Cancel',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  confirm: ReactNode
  onConfirm: () => void
  tone?: 'primary' | 'destructive'
  busy?: boolean
  disabled?: boolean
  cancelLabel?: string
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} walletPrompt={busy === true}>
      {description !== undefined && <div className="-mt-2 leading-snug text-muted-foreground">{description}</div>}
      {children}
      <div className="grid gap-2">
        <Button
          size="lg"
          variant={tone === 'destructive' ? 'destructive' : 'default'}
          busy={busy}
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirm}
        </Button>
        <Button size="lg" variant="secondary" disabled={busy === true} onClick={onClose}>
          {cancelLabel}
        </Button>
      </div>
    </Sheet>
  )
}

/**
 * A button for something that cannot be taken back (reject, decline, disconnect, stop): it asks first, in a destructive
 * `ConfirmSheet` that says what will happen. Confirming closes the sheet and runs `onConfirm`; the button shows it busy.
 */
export function ConfirmButton({
  children,
  title,
  description,
  confirm,
  onConfirm,
  busy,
  disabled,
  variant = 'destructive',
  size,
  className,
}: {
  children: ReactNode
  title: ReactNode
  description: ReactNode
  confirm: ReactNode
  onConfirm: () => void
  busy?: boolean
  disabled?: boolean
  variant?: ComponentProps<typeof Button>['variant']
  size?: ComponentProps<typeof Button>['size']
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant={variant}
        size={size}
        busy={busy}
        disabled={disabled}
        className={className}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        confirm={confirm}
        tone="destructive"
        onConfirm={() => {
          setOpen(false)
          onConfirm()
        }}
      />
    </>
  )
}

type Toast = { id: number; text: ReactNode; tone: 'success' | 'error' }
const ToastContext = createContext<(text: ReactNode, tone?: Toast['tone']) => void>(() => undefined)

/** `useToast()('Paid 4 mUSD to Agent #1942')`: a short, non-blocking confirmation at the top of the screen. */
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: ReactNode, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-0 top-[calc(0.75rem+var(--safe-top))] z-50 grid justify-items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex max-w-md animate-[toast-in_0.45s_var(--ease-sheet)] items-center gap-2.5 rounded-full bg-popover px-4 py-2 text-sm font-medium text-popover-foreground shadow-popover',
              t.tone === 'error' && 'text-destructive-text',
            )}
          >
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full text-micro font-semibold text-background',
                t.tone === 'error' ? 'bg-destructive-text' : 'bg-success-text',
              )}
            >
              {t.tone === 'error' ? '!' : '✓'}
            </span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
