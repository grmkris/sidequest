import { useId } from 'react'
import { CommonsPresentation } from '@sidequest/react/commons-ui'
import { normalizePresentation } from '@sidequest/sdk/commons-ui/openui'
import type { Presentation } from '@sidequest/sdk/commons-ui'
import { Button } from '../ui/button.tsx'
import { Textarea } from '../ui/textarea.tsx'

const starter =
  'root = Plan("Your plan title", "Describe the outcome and how people can help.", [StepList("Steps", [{title: "First step", detail: "Describe what this step produces.", status: "planned"}]), AskQuestion("What should we do next?", ["Build a small prototype", "Discuss the plan first"])])'
export interface AttachmentDraft {
  /** What was typed, so the editor shows it again wherever the composer moves. */
  source: string
  value: Presentation | null
  error: string | null
}

/** Advanced authoring is loaded on request; previews and published attachments share the portable renderer. */
export default function AttachmentEditor({
  disabled,
  draft,
  onChange,
}: {
  disabled: boolean
  draft: AttachmentDraft
  onChange: (draft: AttachmentDraft) => void
}) {
  const id = useId()
  const update = (text: string) => {
    let next: AttachmentDraft
    try {
      next = {
        source: text,
        value:
          text.trim() === ''
            ? null
            : normalizePresentation(
                text.trimStart().startsWith('{') ? JSON.parse(text) : { protocol: 'openui', version: 1, source: text },
              ),
        error: null,
      }
    } catch (error) {
      next = { source: text, value: null, error: error instanceof Error ? error.message : 'Invalid plan' }
    }
    onChange(next)
  }
  return (
    <section className="grid min-w-0 gap-3" aria-label="Plan attachment editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          Plan source
        </label>
        <Button variant="ghost" disabled={disabled} onClick={() => update(starter)}>
          Insert starter plan
        </Button>
      </div>
      <p id={`${id}-help`} className="text-ui text-muted-foreground">
        Paste Commons JSON or OpenUI. Keep a readable summary in your message.{' '}
        <a className="underline underline-offset-4" href="/docs/reference/commons-presentations">
          Components and examples
        </a>
      </p>
      <Textarea
        id={id}
        rows={6}
        value={draft.source}
        onChange={(event) => update(event.target.value)}
        disabled={disabled}
        aria-invalid={draft.error !== null}
        aria-describedby={`${id}-help${draft.error === null ? '' : ` ${id}-error`}`}
        className="max-h-96 font-mono text-sm"
      />
      {draft.error !== null && (
        <p id={`${id}-error`} className="text-sm text-destructive-text">
          {draft.error}
        </p>
      )}
      {draft.value !== null && <CommonsPresentation value={draft.value} />}
    </section>
  )
}
