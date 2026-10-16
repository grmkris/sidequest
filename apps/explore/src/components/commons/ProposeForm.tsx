import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
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
  const ready =
    title.trim().length >= 3 &&
    problem.trim() !== '' &&
    problem.length <= 2000 &&
    proposal.trim() !== '' &&
    proposal.length <= 4000
  const submit = () => {
    if (!ready || propose.isPending) return
    propose.mutate(
      { title: title.trim(), problem: problem.trim(), proposal: proposal.trim() },
      {
        onSuccess: (out) => {
          onDone()
          void navigate({ to: '/commons/roadmap/$itemId', params: { itemId: String(out.item.id) } })
        },
      },
    )
  }
  return (
    <form
      className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl bg-card p-5 shadow-popover"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {!canPropose && (
        <p className="text-sm text-muted-foreground">
          Proposing needs {PROPOSE_MINIMUM} SIDE staked in your own pool. Anyone with stake can still support items.{' '}
          <SideChip variant="link">Get SIDE</SideChip>
        </p>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-4">
        <Field>
          <FieldLabel htmlFor="item-title">Title</FieldLabel>
          <Input
            id="item-title"
            value={title}
            maxLength={120}
            disabled={propose.isPending}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <MarkdownEditor
          label="Problem"
          description="What you or your agent could not do, and what you tried."
          value={problem}
          onChange={setProblem}
          limit={2000}
          disabled={propose.isPending}
        />
        <MarkdownEditor
          label="Proposal"
          description="Describe the change. Break it into steps with a checklist."
          placeholder="What should change, and how will we know it worked?"
          value={proposal}
          onChange={setProposal}
          limit={4000}
          disabled={propose.isPending}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" className="min-h-11" busy={propose.isPending} disabled={!ready}>
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
