import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { Input } from '../ui/input.tsx'
import { Select } from '../kit.tsx'
import { ConfirmButton } from '../Sheet.tsx'
import { GAP_STATUS_LABEL, type Gap, type GapStatus } from '../../commons.ts'
import { useGap, useGapStatus, useLinkGaps, useMergeGaps } from '../../commons-query.ts'
import { positiveId, validPublicReason } from '../../commons-role.ts'
import { RoleReason } from './RoleReason.tsx'

export function GapActions({ gap }: { gap: Gap }) {
  return (
    <section className="grid gap-5 rounded-2xl border border-border bg-card p-4" aria-label="Maintainer actions">
      <h2 className="text-base font-semibold tracking-tight">Maintainer actions</h2>
      <GapStatusForm gap={gap} />
      <LinkGapForm gap={gap} />
      <MergeGapForm target={gap} />
    </section>
  )
}

function GapStatusForm({ gap }: { gap: Gap }) {
  const action = useGapStatus()
  const [status, setStatus] = useState<GapStatus>(gap.status)
  const [reason, setReason] = useState('')
  useEffect(() => setStatus(gap.status), [gap.status])
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!validPublicReason(reason) || status === gap.status) return
        action.mutate({ gapId: gap.id, status, reason: reason.trim() }, { onSuccess: () => setReason('') })
      }}
    >
      <h3 className="font-medium">Set gap status</h3>
      <Select
        value={status}
        onChange={(event) => {
          // SAFETY: this native select contains exactly the three gap statuses.
          setStatus(event.target.value as GapStatus)
        }}
        aria-label="Gap status"
      >
        {Object.entries(GAP_STATUS_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <RoleReason reason={reason} onChange={setReason} disabled={action.isPending} />
      <Button type="submit" busy={action.isPending} disabled={status === gap.status || !validPublicReason(reason)}>
        Save status
      </Button>
      <MutationMessage action={action} success="Status saved; reporters will be notified." />
    </form>
  )
}

function LinkGapForm({ gap }: { gap: Gap }) {
  const action = useLinkGaps()
  const [itemId, setItemId] = useState('')
  const [reason, setReason] = useState('')
  const id = positiveId(itemId)
  return (
    <form
      className="grid gap-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (id === undefined || !validPublicReason(reason)) return
        action.mutate(
          { itemId: id, gapIds: [gap.id], reason: reason.trim() },
          {
            onSuccess: () => {
              setItemId('')
              setReason('')
            },
          },
        )
      }}
    >
      <h3 className="font-medium">Link this gap to a roadmap item</h3>
      <Input
        inputMode="numeric"
        pattern="[1-9]\d*"
        value={itemId}
        onChange={(event) => setItemId(event.target.value)}
        placeholder="Roadmap item ID"
        aria-label="Roadmap item ID"
      />
      {gap.itemIds.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Already linked:{' '}
          {gap.itemIds.map((linkedId) => (
            <Link
              key={linkedId}
              to="/commons/roadmap/$itemId"
              params={{ itemId: String(linkedId) }}
              className="underline underline-offset-4"
            >
              #{linkedId}{' '}
            </Link>
          ))}
        </p>
      )}
      <RoleReason reason={reason} onChange={setReason} disabled={action.isPending} />
      <Button type="submit" busy={action.isPending} disabled={id === undefined || !validPublicReason(reason)}>
        Link gap
      </Button>
      <MutationMessage action={action} success="Roadmap link saved; reporters will hear future status changes." />
    </form>
  )
}

function MergeGapForm({ target }: { target: Gap }) {
  const [sourceId, setSourceId] = useState('')
  const [reason, setReason] = useState('')
  const id = positiveId(sourceId)
  const source = useGap(id ?? 0, id !== undefined && id !== target.id)
  const action = useMergeGaps()
  const ready = source.data?.gap
  return (
    <div className="grid gap-3 border-t border-border pt-4">
      <h3 className="font-medium">Merge another gap into #{target.id}</h3>
      <Input
        inputMode="numeric"
        pattern="[1-9]\d*"
        value={sourceId}
        onChange={(event) => setSourceId(event.target.value)}
        placeholder="Source gap ID"
        aria-label="Source gap ID"
      />
      {id === target.id && <p className="text-sm text-destructive-text">Choose a different gap.</p>}
      {source.error !== null && (
        <p className="text-sm text-destructive-text">Source gap could not be read: {source.error.message}</p>
      )}
      {ready !== undefined && (
        <p className="text-sm text-muted-foreground">
          Source #{ready.id}: {ready.reports} reports. Target #{target.id}: {target.reports} reports. Reports keep their
          original gap IDs.
        </p>
      )}
      <RoleReason reason={reason} onChange={setReason} disabled={action.isPending} />
      <ConfirmButton
        variant="destructive"
        busy={action.isPending}
        disabled={ready === undefined || ready.id === target.id || !validPublicReason(reason)}
        title={`Merge gap #${ready?.id ?? '?'} into gap #${target.id}?`}
        description={
          ready === undefined
            ? 'Read the source gap before confirming.'
            : `${ready.reports} source reports will join ${target.reports} target reports. Their original gap IDs remain visible for provenance. Public reason: ${reason.trim()}`
        }
        confirm="Merge these gaps"
        onConfirm={() => {
          if (ready !== undefined && ready.id !== target.id && validPublicReason(reason))
            action.mutate({ sourceGapId: ready.id, targetGapId: target.id, reason: reason.trim() })
        }}
      >
        Merge gap
      </ConfirmButton>
      <MutationMessage action={action} success="Gaps merged; the target now owns the reports." />
    </div>
  )
}

function MutationMessage({
  action,
  success,
}: {
  action: { error: Error | null; isSuccess: boolean }
  success: string
}) {
  return (
    <>
      {action.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{action.error.message}</AlertDescription>
        </Alert>
      )}
      {action.isSuccess && <output className="text-sm text-muted-foreground">{success}</output>}
    </>
  )
}
