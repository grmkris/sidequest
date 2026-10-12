import { useState } from 'react'
import { useGapModeration } from '../../commons-query.ts'
import { validPublicReason } from '../../commons-role.ts'
import type { GapReport } from '../../commons.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { RoleReason } from './RoleReason.tsx'

/** Moderators and maintainers review the original report and publish a reason for hiding or restoring it. */
export function GapReportControls({ report }: { report: GapReport }) {
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const action = useGapModeration(report.hidden !== null)
  const label = report.hidden === null ? 'Hide report' : 'Restore report'
  return (
    <div className="grid gap-3 border-t border-border pt-3">
      <Button
        variant="outline"
        onClick={() => {
          action.reset()
          setEditing(!editing)
        }}
        disabled={action.isPending}
      >
        {editing ? 'Cancel moderation' : label}
      </Button>
      {editing && (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!validPublicReason(reason)) return
            action.mutate(
              { kind: 'gap_report', id: report.id, reason: reason.trim() },
              {
                onSuccess: () => {
                  setEditing(false)
                  setReason('')
                },
              },
            )
          }}
        >
          <RoleReason reason={reason} onChange={setReason} disabled={action.isPending} />
          <Button type="submit" variant="outline" busy={action.isPending} disabled={!validPublicReason(reason)}>
            {label}
          </Button>
        </form>
      )}
      {action.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{action.error.message}</AlertDescription>
        </Alert>
      )}
      {action.isSuccess && (
        <output className="text-sm text-muted-foreground">Report updated; public reason recorded.</output>
      )}
    </div>
  )
}
