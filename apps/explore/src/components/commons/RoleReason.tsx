import { Field, FieldDescription, FieldLabel } from '../ui/field.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { useId } from 'react'

export function RoleReason({
  reason,
  onChange,
  disabled,
}: {
  reason: string
  onChange: (reason: string) => void
  disabled: boolean
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>Public reason</FieldLabel>
      <Textarea
        id={id}
        value={reason}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby={`${id}-help`}
      />
      <FieldDescription id={`${id}-help`}>
        3–500 characters. This reason appears in the public role log.
      </FieldDescription>
    </Field>
  )
}
