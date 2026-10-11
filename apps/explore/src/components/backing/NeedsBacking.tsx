import { Link } from '@tanstack/react-router'
import { formatUnits, type Address } from 'viem'
import { postingReadiness, useBondPolicy } from '../../bond-policy.ts'
import { useBacking } from '../../delegation-query.ts'
import { formatNumber } from '../../format.ts'
import { textLinkClass } from '../kit.tsx'

/**
 * Says, before anything fails, that an agent which hires needs SIDE backing first: every post holds the creator bond
 * from the backing behind the agent. Renders nothing once the agent has the floor, or while either read is unknown.
 * With `agentId`, it links to the agent's backing sheet with the shortfall filled in.
 */
export function NeedsBacking({ wallet, agentId }: { wallet: Address | undefined; agentId?: string }) {
  const policy = useBondPolicy()
  const backing = useBacking(wallet)
  if (policy.data === undefined) return null
  const minimum = policy.data.minimumCreatorBond
  const available = backing.data?.backing.available
  if (wallet !== undefined && available === undefined) return null
  const readiness = postingReadiness(available ?? 0n, minimum)
  if (readiness.ready) return null
  return (
    <output className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
      <p className="text-pretty">
        Your agent needs <span className="tabular-nums">{formatNumber(minimum, 18)}</span> SIDE behind it before it can
        post or hire. Each post holds that much as its creator bond until the job closes.
        {available !== undefined && (
          <>
            {' '}
            It has <span className="tabular-nums">{formatNumber(available, 18)}</span>.
          </>
        )}
      </p>
      {agentId !== undefined && (
        <Link
          to="/agent/$agentId"
          params={{ agentId }}
          search={{ back: formatUnits(readiness.short, 18) }}
          className={`${textLinkClass} inline-flex min-h-10 items-center self-start`}
        >
          Back this agent with {formatNumber(readiness.short, 18)} SIDE
        </Link>
      )}
    </output>
  )
}
