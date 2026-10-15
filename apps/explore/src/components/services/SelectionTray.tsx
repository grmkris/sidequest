import { Check, Copy, X } from 'lucide-react'
import { useId, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { combinedAskPrompt, selectionKey } from '../../service-ask.ts'
import type { useServiceSelection } from '../../useServiceSelection.ts'
import { startOrigin, useCopy } from '../AgentStartLink.tsx'
import { Sheet } from '../Sheet.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { ServiceCover } from './ServiceCover.tsx'

type Selection = ReturnType<typeof useServiceSelection>

const FOOTER = 'Paste this into your agent. Nothing is posted from this page.'

/**
 * The picked services, floating over the page in a glass capsule: what is picked, the prompt that asks for all of
 * them, and a way to clear. Picks are kept across pages in this tab, so the tray follows from the landing to Services
 * and an agent's page. In the app (`app`) it sits above the phone's tab bar and beside the sidebar on a wide screen.
 */
export function SelectionTray({ selection, app = true }: { selection: Selection; app?: boolean }) {
  return selection.listings.length === 0 ? null : <PickedTray selection={selection} app={app} />
}

function PickedTray({ selection, app }: { selection: Selection; app: boolean }) {
  const [open, setOpen] = useState(false)
  const [origin, setOrigin] = useState<string | null>(null)
  const count = selection.listings.length
  return (
    <>
      <div className="h-20" aria-hidden />
      <aside
        aria-label="Picked services"
        className={cn(
          'pointer-events-none fixed inset-x-0 z-30 flex justify-center ps-[max(1rem,var(--safe-left))] pe-[max(1rem,var(--safe-right))] animate-[step-in_0.3s_var(--ease-out-strong)]',
          app
            ? 'bottom-[calc(4.25rem+var(--safe-bottom))] lg:bottom-[calc(1rem+var(--safe-bottom))] lg:ps-[calc(15rem+1rem)]'
            : 'bottom-[calc(1rem+var(--safe-bottom))]',
        )}
      >
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full py-1.5 ps-2 pe-1.5 shadow-popover material-chrome">
          <span aria-hidden className="flex shrink-0">
            {selection.listings.slice(0, 3).map((listing, i) => (
              <ServiceCover
                key={selectionKey(listing)}
                listing={listing}
                className={cn('size-9 rounded-full ring-2 ring-background', i > 0 && '-ms-3')}
              />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums" aria-live="polite">
            {count} {count === 1 ? 'service' : 'services'}
          </span>
          <Button
            className="min-h-10 rounded-full px-4"
            aria-haspopup="dialog"
            onClick={() => {
              setOrigin(startOrigin())
              setOpen(true)
            }}
          >
            Get prompt
          </Button>
          <button
            type="button"
            aria-label="Clear picked services"
            onClick={selection.clear}
            className="grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground transition-[color,scale] duration-(--dur-fast) active:scale-96 [@media(hover:hover)]:hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      </aside>
      {origin !== null && (
        <RequestSheet selection={selection} open={open} onClose={() => setOpen(false)} origin={origin} />
      )}
    </>
  )
}

function RequestSheet({
  selection,
  open,
  onClose,
  origin,
}: {
  selection: Selection
  open: boolean
  onClose: () => void
  origin: string
}) {
  const [brief, setBrief] = useState('')
  const briefId = useId()
  return (
    <Sheet open={open} onClose={onClose} title="Ask for your picks" className="sm:w-[34rem]">
      <ul className="grid gap-2">
        {selection.listings.map((listing) => (
          <li key={selectionKey(listing)} className="flex items-center gap-3">
            <ServiceCover listing={listing} className="aspect-4/3 w-16 shrink-0 rounded-lg" />
            <div className="grid min-w-0 flex-1 gap-0.5 text-pretty">
              <span className="font-medium">{listing.name}</span>
              <span className="text-xs text-muted-foreground">{listing.agentName}</span>
            </div>
            <Button
              variant="ghost"
              className="min-h-10"
              aria-label={`Remove ${listing.name}`}
              onClick={() => selection.toggle(listing)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Field>
        <FieldLabel htmlFor={briefId}>Your brief</FieldLabel>
        <Textarea
          id={briefId}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="What would you like made?"
          className="text-base"
          rows={3}
        />
      </Field>
      <PromptBlock prompt={combinedAskPrompt(origin, selection.listings, brief)} />
    </Sheet>
  )
}

/** The prompt itself, readable, with one Copy; nothing leaves the page until it is pasted into an agent. */
function PromptBlock({ prompt }: { prompt: string }) {
  const [copied, copy] = useCopy()
  return (
    <div className="grid gap-2.5">
      <code className="max-h-48 overflow-y-auto rounded-xl bg-muted px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {prompt}
      </code>
      <Button size="lg" onClick={() => copy(prompt)}>
        {copied ? <Check aria-hidden data-icon="inline-start" /> : <Copy aria-hidden data-icon="inline-start" />}
        {copied ? 'Copied' : 'Copy prompt'}
      </Button>
      <p className="text-xs text-pretty text-muted-foreground">{FOOTER}</p>
    </div>
  )
}
