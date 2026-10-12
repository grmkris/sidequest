import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { GapReports } from '../components/commons/GapReports.tsx'
import { GAP_LABEL, GAP_STATUS_LABEL, type GapDetail } from '../commons.ts'
import { useGap, useRoles } from '../commons-query.ts'

/** A stable public link to all reports; merged IDs resolve through the backend's canonical gap. */
export function GapPage() {
  const { gapId: raw } = useParams({ from: '/commons/gaps/$gapId' })
  const id = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN
  const roles = useRoles()
  const detail = useGap(id, roles.data?.enabled !== false)
  const navigate = useNavigate()
  const canonical = detail.data?.gap.id
  useEffect(() => {
    if (canonical !== undefined && canonical !== id)
      void navigate({ to: '/commons/gaps/$gapId', params: { gapId: String(canonical) }, replace: true })
  }, [canonical, id, navigate])
  const back = (
    <Link to="/commons" search={{ tab: 'gaps' }} className="text-sm text-muted-foreground underline underline-offset-4">
      Back to gaps
    </Link>
  )
  if (roles.data?.enabled === false)
    return (
      <>
        {back}
        <PageTitle>Commons</PageTitle>
        <p className="text-muted-foreground">Commons is not open on this network yet.</p>
      </>
    )
  if (detail.isLoading)
    return (
      <>
        {back}
        <LoadingRows rows={4} />
      </>
    )
  if (detail.data === undefined)
    return (
      <>
        {back}
        <Alert variant="destructive">
          <AlertDescription>
            This gap could not be read: {detail.error?.message ?? 'invalid or missing gap ID'}.{' '}
            {Number.isSafeInteger(id) && id > 0 && (
              <Button variant="link" onClick={() => void detail.refetch()}>
                Retry
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </>
    )
  return <GapContent detail={detail.data} />
}

function GapContent({ detail: { gap, reports } }: { detail: GapDetail }) {
  return (
    <>
      <Link
        to="/commons"
        search={{ tab: 'gaps' }}
        className="text-sm text-muted-foreground underline underline-offset-4"
      >
        Back to gaps
      </Link>
      <PageTitle
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="warning">{GAP_LABEL[gap.gapType]}</Badge>
            <Badge variant="outline">{GAP_STATUS_LABEL[gap.status]}</Badge>
            {gap.tool !== null && <code>{gap.tool}</code>}
          </span>
        }
      >
        Gap #{gap.id}
      </PageTitle>
      <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
        {gap.needed || 'Report text is hidden.'}
      </p>
      <p className="text-sm text-muted-foreground">
        {gap.reports} report{gap.reports === 1 ? '' : 's'} from {gap.reporters} reporter{gap.reporters === 1 ? '' : 's'}
      </p>
      {gap.itemIds.length > 0 && (
        <Section title="Roadmap items">
          <div className="flex flex-wrap gap-3">
            {gap.itemIds.map((itemId) => (
              <Link
                key={itemId}
                to="/commons/roadmap/$itemId"
                params={{ itemId: String(itemId) }}
                className="text-sm underline underline-offset-4"
              >
                Roadmap #{itemId}
              </Link>
            ))}
          </div>
        </Section>
      )}
      <Section title="Individual reports">
        <GapReports reports={reports} />
      </Section>
      <Link
        to="/commons"
        search={{ tab: 'roles' }}
        className="text-sm text-muted-foreground underline underline-offset-4"
      >
        Public role actions and reasons
      </Link>
    </>
  )
}
