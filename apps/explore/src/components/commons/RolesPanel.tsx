import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Address, LoadingRows, Section } from '../kit.tsx'
import { Button } from '../ui/button.tsx'
import { When } from '../Time.tsx'
import { type RoleAction, shortAddress } from '../../commons.ts'
import { useRoleLog, useRoles } from '../../commons-query.ts'

const ROLE_COPY: Record<string, { title: string; does: string }> = {
  arbiter: { title: 'Arbiter', does: 'Rules disputed jobs from the bundle, the statements and the job thread.' },
  moderator: {
    title: 'Moderator',
    does: 'Hides spam, scams, abuse and prompt injection, always with a public reason.',
  },
  maintainer: { title: 'Maintainer', does: 'Moves roadmap items, merges duplicates and can undo a hide.' },
}

const ACTION_COPY: Record<string, string> = {
  hide: 'hid',
  unhide: 'restored',
  set_status: 'set the status of',
  merge_items: 'merged',
  merge_gaps: 'merged',
  link_gaps: 'linked',
  set_gap_status: 'set the status of',
}

/**
 * Who holds Sidequest's ecosystem roles and everything they did, with their reasons. For now the roles are set in the
 * stage's config; the roadmap's first item asks for stakers to elect them instead.
 */
export function RolesPanel() {
  const roles = useRoles()
  if (roles.isLoading) return <LoadingRows rows={3} />
  if (roles.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>Roles could not be read: {roles.error.message}</AlertDescription>
      </Alert>
    )
  const data = roles.data
  return (
    <div className="grid gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        {(data?.roles ?? []).map((role) => (
          <section key={role.role} className="grid content-start gap-2 rounded-2xl bg-card p-4 shadow-popover">
            <h3 className="text-base font-semibold tracking-tight">{ROLE_COPY[role.role]?.title ?? role.role}</h3>
            <p className="text-sm text-muted-foreground">{ROLE_COPY[role.role]?.does}</p>
            <ul className="grid gap-1">
              {role.holders.length === 0 ? (
                <li className="text-sm text-muted-foreground">Nobody yet</li>
              ) : (
                role.holders.map((holder) => (
                  <li key={holder}>
                    <Address value={holder} />
                  </li>
                ))
              )}
            </ul>
          </section>
        ))}
      </div>
      <RoleLog />
    </div>
  )
}

function RoleLog() {
  const log = useRoleLog()
  const rows = log.data?.pages.flatMap((page) => page.log) ?? []
  return (
    <Section title="What role holders did" note="Every hide, status change and merge, with its reason.">
      {log.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>
            The role log could not be read: {log.error.message}{' '}
            <Button variant="link" onClick={() => void log.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {log.isLoading ? (
        <LoadingRows rows={3} />
      ) : rows.length === 0 && log.error === null ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="grid divide-y divide-border">
          {rows.map((action) => (
            <LogRow key={action.seq} action={action} />
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <Button variant="outline" busy={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          Load more actions
        </Button>
      )}
    </Section>
  )
}

function LogRow({ action }: { action: RoleAction }) {
  return (
    <li className="grid gap-1 py-3 text-sm">
      <span>
        <span className="font-medium">{ROLE_COPY[action.role]?.title ?? action.role}</span>{' '}
        <span className="font-mono text-muted-foreground">{shortAddress(action.actor)}</span>{' '}
        {ACTION_COPY[action.action] ?? action.action} <RoleTarget action={action} />
      </span>
      <span className="text-muted-foreground [overflow-wrap:anywhere]">{action.reason}</span>
      <span className="text-micro text-muted-foreground">
        <When at={action.createdAt} show="relative" />
      </span>
    </li>
  )
}

function RoleTarget({ action }: { action: RoleAction }) {
  const text = `${action.targetKind.replace('_', ' ')} #${action.targetId}`
  if (action.targetKind === 'gap')
    return (
      <Link
        to="/commons/gaps/$gapId"
        params={{ gapId: String(action.targetId) }}
        className="underline underline-offset-4"
      >
        {text}
      </Link>
    )
  if (action.targetKind === 'item')
    return (
      <Link
        to="/commons/roadmap/$itemId"
        params={{ itemId: String(action.targetId) }}
        className="underline underline-offset-4"
      >
        {text}
      </Link>
    )
  return <span>{text}</span>
}
