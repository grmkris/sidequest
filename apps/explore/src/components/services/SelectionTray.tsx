import { useId, useState } from 'react'
import { combinedAskPrompt, selectionKey } from '../../service-ask.ts'
import type { useServiceSelection } from '../../useServiceSelection.ts'
import { startOrigin } from '../AgentStartLink.tsx'
import { PromptInstruction } from '../CreateWithAgent.tsx'
import { Sheet } from '../Sheet.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Textarea } from '../ui/textarea.tsx'

type Selection = ReturnType<typeof useServiceSelection>

const FOOTER = 'Paste this into your agent. Nothing is posted from this page.'

export function SelectionTray({ selection }: { selection: Selection }) {
  return selection.listings.length === 0 ? null : <PickedTray selection={selection} />
}

function PickedTray({ selection }: { selection: Selection }) {
  const [open, setOpen] = useState(false)
  const [origin, setOrigin] = useState<string | null>(null)
  return (
    <>
      <div className="h-28" aria-hidden />
      <aside
        aria-label="Picked services"
        className="fixed inset-x-0 bottom-0 z-40 grid gap-1.5 border-t bg-background ps-[max(1.25rem,var(--safe-left))] pe-[max(1.25rem,var(--safe-right))] pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] text-sm shadow-popover"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium tabular-nums" aria-live="polite">
            {selection.listings.length} picked
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" className="min-h-10" onClick={selection.clear}>
              Clear
            </Button>
            <Button
              className="min-h-10"
              aria-haspopup="dialog"
              onClick={() => {
                setOrigin(startOrigin())
                setOpen(true)
              }}
            >
              Get prompt
            </Button>
          </div>
        </div>
        <p className="text-xs text-pretty text-muted-foreground">{FOOTER}</p>
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
    <Sheet open={open} onClose={onClose} title="Your picked services">
      <ul className="grid gap-2">
        {selection.listings.map((listing) => (
          <li key={selectionKey(listing)} className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
            <div className="grid min-w-0 gap-1 text-pretty">
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
      <PromptInstruction prompt={combinedAskPrompt(origin, selection.listings, brief)} />
      <p className="text-xs text-pretty text-muted-foreground">{FOOTER}</p>
    </Sheet>
  )
}
