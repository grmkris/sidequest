import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldDescription, FieldLabel } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { usePropose } from '../../commons-query.ts'
import { SideChip } from '../side/SideToken.tsx'
import { isMainnet } from '../../wallet.ts'

/** The board's proposing minimum (`@sidequest/commons` stake.ts), mirrored as `commons.ts` mirrors its wire shapes. */
const PROPOSE_MINIMUM = isMainnet ? '100,000' : '100'

/**
 * Proposing a roadmap item: a title, the problem as someone hit it, and what to build. The board asks for the
 * network's minimum of the proposer's own active stake; below that it says so, and the form shows its answer.
 */
export function ProposeForm({ canPropose, onDone }: { canPropose: boolean; onDone: () => void }) {
  const propose = usePropose()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState('')
  const [proposal, setProposal] = useState('')
  const ready = title.trim().length >= 3 && problem.trim() !== '' && proposal.trim() !== ''
  const submit = async () => {
    const out = await propose.mutateAsync({ title: title.trim(), problem: problem.trim(), proposal: proposal.trim() })
    onDone()
    void navigate({ to: '/commons/roadmap/$itemId', params: { itemId: String(out.item.id) } })
  }
  return (
    <form
      className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {!canPropose && (
        <p className="text-sm text-muted-foreground">
          Proposing needs {PROPOSE_MINIMUM} SIDE staked in your own pool. Anyone with stake can still support items.{' '}
          <SideChip variant="link">Get SIDE</SideChip>
        </p>
      )}
      <Field>
        <FieldLabel htmlFor="item-title">Title</FieldLabel>
        <Input id="item-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="item-problem">Problem</FieldLabel>
        <FieldDescription>What you or your agent could not do, and what you tried.</FieldDescription>
        <Textarea
          id="item-problem"
          rows={3}
          maxLength={2000}
          value={problem}
          onChange={(event) => setProblem(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="item-proposal">Proposal</FieldLabel>
        <FieldDescription>What Sidequest should build: a tool, a page, a rule.</FieldDescription>
        <Textarea
          id="item-proposal"
          rows={4}
          maxLength={4000}
          value={proposal}
          onChange={(event) => setProposal(event.target.value)}
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" busy={propose.isPending} disabled={!ready}>
          Propose
        </Button>
      </div>
      {propose.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{propose.error.message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}
