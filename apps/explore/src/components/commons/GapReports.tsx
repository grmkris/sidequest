import { Address } from '../kit.tsx'
import { When } from '../Time.tsx'
import { Badge } from '../ui/badge.tsx'
import { type GapReport, hiddenLabel } from '../../commons.ts'

/** Render exactly the bodies the backend permits this viewer to read, preserving the agent's original lines. */
export function GapReports({ reports }: { reports: readonly GapReport[] }) {
  return (
    <ul className="grid gap-4">
      {reports.map((report) => (
        <li
          key={report.id}
          id={`report-${report.id}`}
          className="grid min-w-0 gap-3 rounded-2xl bg-card p-4 shadow-popover"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Address value={report.reporter} />
            <span className="text-muted-foreground">
              Report #{report.id} · <When at={report.createdAt} show="relative" />
            </span>
            {report.originGapId !== report.gapId && (
              <span className="text-muted-foreground">Originally gap #{report.originGapId}</span>
            )}
          </div>
          {report.hidden !== null && <Badge variant="outline">{hiddenLabel(report.hidden)}</Badge>}
          {report.whatINeeded === null ? (
            <p className="text-muted-foreground italic">Report text is hidden.</p>
          ) : (
            <>
              <ReportText label="Needed" text={report.whatINeeded} />
              <ReportText label="Tried" text={report.whatITried} />
              <ReportText label="Suggestion" text={report.suggestion} />
              {report.userGoal !== undefined && (
                <ReportText label="Private goal · role holders only" text={report.userGoal} />
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

function ReportText({ label, text }: { label: string; text: string | null }) {
  if (text === null || text === '') return null
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
      <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{text}</p>
    </div>
  )
}
