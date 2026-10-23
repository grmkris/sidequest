/** GitHubPolicyForm and custom provider adapted from https://ui.shadcn.com/oidc. */
import { useId, useState } from 'react'
import { compileWorkloadPolicy, workloadDefaults, type WorkloadFields } from '../../workload-policy.ts'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { Button } from '../ui/button.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'

type ControlProps = { fields: WorkloadFields; busy: boolean; change: (patch: Partial<WorkloadFields>) => void }
type TextField = 'label' | 'audience' | 'repository' | 'branch' | 'workflow' | 'issuer' | 'subject'

function PolicyField({
  fields,
  busy,
  change,
  id,
  name,
  label,
  placeholder,
}: ControlProps & { id: string; name: TextField; label: string; placeholder: string | undefined }) {
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${id}-${name}`}
        value={fields[name]}
        placeholder={placeholder}
        required
        disabled={busy}
        onChange={(event) => change({ [name]: event.target.value })}
      />
    </Field>
  )
}

function PolicyPlatform({ fields, busy, id, change }: ControlProps & { id: string }) {
  return (
    <fieldset className="flex flex-wrap gap-4" disabled={busy}>
      <legend className="text-sm font-medium">Platform</legend>
      {(['github', 'custom'] as const).map((provider) => (
        <label key={provider} className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name={`${id}-provider`}
            checked={fields.provider === provider}
            onChange={() => change({ provider })}
          />
          {provider === 'github' ? 'GitHub Actions' : 'Custom issuer'}
        </label>
      ))}
    </fieldset>
  )
}

function PolicyScopes({ fields, busy, change }: ControlProps) {
  return (
    <fieldset className="grid gap-1" disabled={busy}>
      <legend className="text-sm font-medium">Maximum access</legend>
      <p className="text-ui text-muted-foreground">Read access is included. The agent’s current roles also apply.</p>
      {(['work', 'hire'] as const).map((role) => (
        <label key={role} className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={fields[role]}
            onChange={(event) => change({ [role]: event.target.checked })}
          />
          {role === 'work' ? 'Get hired' : 'Hire other agents'}
        </label>
      ))}
    </fieldset>
  )
}

type Payload = ReturnType<typeof compileWorkloadPolicy>

export function WorkloadPolicyForm({
  resource,
  onSave,
  initial = workloadDefaults,
}: {
  resource: string
  onSave: (payload: Payload) => Promise<void>
  initial?: WorkloadFields
}) {
  const id = useId()
  const [fields, setFields] = useState({
    ...initial,
    audience: initial.audience || `${new URL(resource).origin}/oauth/token`,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (patch: Partial<WorkloadFields>) => setFields((previous) => ({ ...previous, ...patch }))
  const field = (name: TextField, label: string, placeholder?: string) => (
    <PolicyField {...{ fields, busy, change, id, name, label, placeholder }} />
  )
  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await onSave(compileWorkloadPolicy(fields, resource))
      setFields({ ...workloadDefaults, audience: fields.audience })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The policy could not be saved')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      aria-label="Trust a workload"
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <PolicyPlatform fields={fields} busy={busy} id={id} change={change} />
      {field('label', 'Policy name')}
      {field('audience', 'Audience')}
      {fields.provider === 'github' ? (
        <>
          {field('repository', 'Repository', 'owner/repo')}
          {field('branch', 'Branch', 'main')}
          {field('workflow', 'Workflow path', '.github/workflows/agent.yml')}
        </>
      ) : (
        <>
          {field('issuer', 'HTTPS issuer')}
          {field('subject', 'Subject')}
          <Field>
            <FieldLabel htmlFor={`${id}-claims`}>Additional claim rules (JSON)</FieldLabel>
            <Textarea
              id={`${id}-claims`}
              value={fields.extraClaims}
              disabled={busy}
              onChange={(event) => setFields({ ...fields, extraClaims: event.target.value })}
            />
          </Field>
        </>
      )}
      <PolicyScopes fields={fields} busy={busy} change={change} />
      <Button type="submit" busy={busy} className="justify-self-start">
        Save trust policy
      </Button>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}
