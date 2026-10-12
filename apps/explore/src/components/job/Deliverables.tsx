import { Badge } from '../ui/badge.tsx'
import { cn } from '../../lib/cn.ts'
import { Item, ItemGroup, ItemContent } from '../ui/item.tsx'
import { Address, Section, TxLink, textLinkClass } from '../kit.tsx'
/**
 * Where the work is (ADR-0006: a git commit, a patch, a file, a live URL or an on-chain result) and what was checked
 * about it: the board's one-time check at submit (advisory) and any signed attestation of a required GitHub check.
 */
import { Check, CircleAlert, ExternalLink } from 'lucide-react'
import type { Deliverable, DeliverableCheck } from '../../api.ts'
import { KIND, gitTree, httpUrl, repoName } from '../../delivery.ts'

/** Only web links open: a deliverable names its own URL, so any other scheme (javascript:, data:) shows as text. */
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <span className="[overflow-wrap:anywhere]">{children}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(textLinkClass, 'inline-flex max-w-full items-center gap-1 [overflow-wrap:anywhere]')}
    >
      <span className="min-w-0">{children}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0" />
    </a>
  )
}

function Where({ d }: { d: Deliverable }) {
  switch (d.kind) {
    case 'git':
      return (
        <Link href={gitTree(d.url, d.sha)}>
          {repoName(d.url)} · {d.ref} @ {d.sha.slice(0, 7)}
        </Link>
      )
    case 'patch':
      return <Link href={httpUrl(d.url)}>Patch on {d.base.slice(0, 7)}</Link>
    case 'artifact':
      return (
        <Link href={httpUrl(d.url)}>
          {d.name} ({d.mediaType})
        </Link>
      )
    case 'url':
      return <Link href={d.url}>{d.url.replace(/^https?:\/\//, '')}</Link>
    case 'onchain':
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          {d.txHash !== undefined && <TxLink hash={d.txHash} />}
          {d.address !== undefined && <Address value={d.address} />}
        </span>
      )
  }
}

function CheckLine({ check }: { check: DeliverableCheck | null }) {
  if (check === null) return null
  const ok = check.ok === true
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-ui',
        ok ? 'text-success-text' : check.ok === false ? 'text-destructive-text' : 'text-muted-foreground',
      )}
    >
      {ok ? (
        <Check aria-hidden className="size-3.5" strokeWidth={3} />
      ) : (
        <CircleAlert aria-hidden className="size-3.5" />
      )}
      {ok ? 'Checked at submit' : check.ok === false ? 'Check at submit failed' : 'Not checked'}
      <span className="text-muted-foreground">· {check.detail}</span>
    </span>
  )
}

/** One deliverable as a line of text, with its check. */
function DeliverableLine({ d, check }: { d: Deliverable; check: DeliverableCheck | null }) {
  return (
    <span className="grid gap-0.5 text-sm">
      <span className="text-muted-foreground">
        {KIND[d.kind]} · <Where d={d} />
      </span>
      <CheckLine check={check} />
    </span>
  )
}

export interface EvidenceRow {
  verifier: string
  submission_hash: string
  tested_sha: string
  conclusion: string
  expired: boolean
  onchainMatch: boolean
  tx_hash: string
}

export function Delivered({
  deliverables,
  evidence,
}: {
  deliverables: Array<{ deliverable_hash: string; descriptor: Deliverable; check: DeliverableCheck | null }>
  evidence: EvidenceRow[]
}) {
  if (deliverables.length === 0 && evidence.length === 0) return null
  return (
    <Section
      title="Delivered"
      note="The board checks a delivery once when it is submitted; that check is advice. The approver decides."
    >
      <ItemGroup role="presentation">
        <ul>
          {deliverables.map((x) => (
            <Item render={<li />} key={x.deliverable_hash}>
              <DeliverableLine d={x.descriptor} check={x.check} />
            </Item>
          ))}
          {evidence.map((e) => (
            <Item render={<li />} key={e.tx_hash}>
              <ItemContent className="grid flex-1 gap-1 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={e.conclusion === 'success' ? 'success' : 'destructive'}>
                    {e.conclusion === 'success' ? 'Check passed' : 'Check failed'}
                  </Badge>
                  <span className="text-muted-foreground">
                    {e.onchainMatch
                      ? 'on the delivered commit'
                      : e.expired
                        ? 'attestation expired'
                        : 'on a different commit'}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
                  Signed by <Address value={e.verifier} /> <TxLink hash={e.tx_hash} />
                </span>
              </ItemContent>
            </Item>
          ))}
        </ul>
      </ItemGroup>
    </Section>
  )
}
