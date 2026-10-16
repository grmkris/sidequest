import { useEffect, useId, useRef } from 'react'
import { Field, FieldDescription, FieldLabel } from '../ui/field.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { Markdown } from './Markdown.tsx'

interface EditorProps {
  label: string
  value: string
  onChange: (value: string) => void
  limit: number
  description?: string
  placeholder?: string
  disabled?: boolean
  replyId?: number
}

/** Preview matches published content; switching tabs never changes the draft. */
export function MarkdownEditor({
  label,
  value,
  onChange,
  limit,
  description,
  placeholder,
  disabled,
  replyId,
}: EditorProps) {
  const id = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const invalid = value.length > limit
  useEffect(() => {
    if (replyId !== undefined) input.current?.focus()
  }, [replyId])
  return (
    <Field data-invalid={invalid} className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {description !== undefined && <FieldDescription>{description}</FieldDescription>}
      <Tabs key={replyId} defaultValue="write" className="min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label={`${label} editor`} className="group-data-horizontal/tabs:h-11">
            <TabsTrigger value="write" className="min-w-16 px-3">
              Write
            </TabsTrigger>
            <TabsTrigger value="preview" className="min-w-20 px-3">
              Preview
            </TabsTrigger>
          </TabsList>
          <span id={`${id}-count`} className="text-ui text-muted-foreground tabular-nums">
            {value.length} / {limit}
          </span>
        </div>
        <TabsContent value="write" keepMounted className="min-w-0 data-[hidden]:hidden">
          <Textarea
            ref={input}
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            rows={4}
            aria-invalid={invalid}
            aria-describedby={`${id}-help ${id}-count${invalid ? ` ${id}-error` : ''}`}
            className="min-h-32 max-h-96"
          />
        </TabsContent>
        <TabsContent
          value="preview"
          className="min-w-0 min-h-32 rounded-lg border border-input p-3"
          aria-label={`${label} preview`}
        >
          {value.trim() === '' ? (
            <p className="text-muted-foreground">Nothing to preview yet. Write something first.</p>
          ) : (
            <Markdown>{value}</Markdown>
          )}
        </TabsContent>
      </Tabs>
      <p id={`${id}-help`} className="text-ui text-muted-foreground">
        Markdown supported: <code>**bold**</code>, <code>[link](url)</code>, <code>- [ ] task</code>.
      </p>
      {invalid && (
        <p id={`${id}-error`} className="text-sm text-destructive-text">
          Remove {value.length - limit} {value.length - limit === 1 ? 'character' : 'characters'} to continue.
        </p>
      )}
    </Field>
  )
}
