import { cn } from '../lib/cn.ts'
import { walletRecord } from '../wallet-record.ts'
import { useFeedJobs } from './activity/useActivityFeed.ts'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { BoardLink, type LinkTarget } from './BoardLink.tsx'
import { CardAction, CardLink, useCardFrame } from './CardLink.tsx'
import { CopyButton, Stat, shortAddress } from './kit.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'
import { Badge } from './ui/badge.tsx'
import { Skeleton } from './ui/skeleton.tsx'
import { Monogram, useAuth } from './Wallet.tsx'

/** A wallet's page; one for every board, since a wallet's record spans them. */
const walletTarget = (address: string): LinkTarget => ({ to: '/wallet/$address', params: { address } })

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return <Stat size="sm" label={label} value={children} />
}

/** A wallet's card: its mark and address, what it posted, paid out and who it hired, and its page. */
function WalletCard({ address }: { address: string }) {
  const { feed, loading } = useFeedJobs()
  const { address: viewer } = useAuth()
  const { inSheet } = useCardFrame()
  const record = walletRecord(feed, address)
  const [paid] = record.paid
  const you = viewer !== undefined && viewer.toLowerCase() === address.toLowerCase()
  return (
    <div className={cn('grid gap-3', !inSheet && 'p-3.5')}>
      <header className="flex items-center gap-3">
        <span className="inline-flex size-11 [&>span]:size-full">
          <Monogram seed={address} />
        </span>
        <span className="grid min-w-0 gap-0.5">
          {/* A sheet's title already shows the address. */}
          {!inSheet && <span className="truncate font-mono text-ui font-medium">{shortAddress(address)}</span>}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {you && <Badge variant="info">You</Badge>}A wallet without an agent
            <CopyButton value={address} label="Copy address" />
          </span>
        </span>
      </header>
      {loading ? (
        <Skeleton className="h-14 w-full rounded-lg" />
      ) : (
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-ui">
          <Figure label="Posted">{record.posted}</Figure>
          <Figure label="Paid out">
            {paid === undefined ? 'None' : <TokenAmount value={paid.value} token={paid.token} static />}
            {record.paid.length > 1 && <span className="text-muted-foreground"> +{record.paid.length - 1}</span>}
          </Figure>
          <Figure label="Agents hired">
            {record.hired.length === 0 ? (
              'None'
            ) : (
              <span className="flex items-center -space-x-1.5">
                {record.hired.slice(0, 4).map((h) => (
                  <AgentOrb key={h.agentId} agentId={h.agentId} size="sm" className="ring-2 ring-popover" />
                ))}
                {record.hired.length > 4 && (
                  <span className="pl-2.5 text-xs text-muted-foreground">+{record.hired.length - 4}</span>
                )}
              </span>
            )}
          </Figure>
        </dl>
      )}
      <div className={cn('flex', !inSheet && 'justify-end')}>
        <CardAction target={walletTarget(address)}>Open wallet</CardAction>
      </div>
    </div>
  )
}

/**
 * A wallet no agent names, as people meet it in a sentence: a colour mark seeded from the address and the address
 * shortened. A press opens its card, which leads to its page; inside another popover (`card={false}`) it goes to the
 * page directly. `orb` leaves the mark out where a row already shows it.
 */
export function WalletLink({
  address,
  orb = true,
  card = true,
  className,
}: {
  address: string
  orb?: boolean
  card?: boolean
  className?: string
}) {
  const look = cn(
    'inline-flex items-center gap-1.5 align-bottom font-medium underline-offset-4 [@media(hover:hover)]:hover:underline',
    className,
  )
  const content = (
    <>
      {orb && <Monogram seed={address} />}
      <span className="font-mono text-[0.92em]">{shortAddress(address)}</span>
    </>
  )
  if (!card)
    return (
      <BoardLink target={walletTarget(address)} aria-label={`Wallet ${address}`} className={look}>
        {content}
      </BoardLink>
    )
  return (
    <CardLink
      target={walletTarget(address)}
      title={<span className="font-mono">{shortAddress(address)}</span>}
      card={<WalletCard address={address} />}
      label={`Wallet ${address}`}
      className={look}
    >
      {content}
    </CardLink>
  )
}

/** The wallet's mark alone, sized like an agent's orb in the same place; it opens the same card, decoratively. */
export function WalletOrb({ address, className }: { address: string; className?: string }) {
  return (
    <CardLink
      decorative
      target={walletTarget(address)}
      title={<span className="font-mono">{shortAddress(address)}</span>}
      card={<WalletCard address={address} />}
      className={cn('inline-flex rounded-full [&>span]:size-full', className)}
    >
      <Monogram seed={address} />
    </CardLink>
  )
}
