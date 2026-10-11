import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel, FieldDescription } from '../ui/field.tsx'
import { Input } from '../ui/input.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Section } from '../kit.tsx'
import { useState } from 'react'
import { type Address, type Hex, parseUnits } from 'viem'
import { useSignTypedData } from 'wagmi'
import { agentEndpoint, type ManagedAgent } from '../../api.ts'
import type { AgentApproval } from '../../agent-api.ts'
import { formatNumber, localTime, relative, tokenMeta } from '../../format.ts'
import {
  assertFreshAnchor,
  decodeExactCall,
  expectedPermission,
  permissionRequest,
  reviewPermission,
  tokenAmountText,
  type PreparedPermission,
} from '../../permission-review.ts'
import { typedDataArgs } from '../../typed-data.ts'
import { useTokenList } from '../../useTokens.ts'
import { deployment } from '../../wallet.ts'

const TYPE_WORDS: Record<string, string> = {
  'erc20-token-periodic': 'Recurring token payments',
  'erc20-token-allowance': 'One token spending limit',
  'sidequest:contract-call': 'One exact contract call',
}

/** The one exact call, in full: decoded arguments when the method is known, and always the raw call data (VV2-022). */
function ExactCall({ target, value, callData }: { target: Address; value: bigint; callData: Hex }) {
  const decoded = decodeExactCall(callData)
  const meta = tokenMeta(target)
  return (
    <div className="grid gap-1 text-sm leading-relaxed text-muted-foreground">
      <p className="break-all">
        Your account makes this one call, once, to {target}
        {value > 0n ? `, sending ${value.toString()} wei` : ''}:
      </p>
      {decoded === null ? (
        <p>Unrecognised method {callData.slice(0, 10)}: only the call data below says what it does.</p>
      ) : (
        <ul className="grid gap-0.5">
          <li className="font-mono">{decoded.functionName}</li>
          {decoded.args.map((arg) => (
            <li key={arg.name} className="break-all">
              {arg.name}:{' '}
              {arg.name === 'amount' && meta !== undefined
                ? `${formatNumber(BigInt(arg.value), meta.decimals)} ${meta.symbol} (${arg.value} base units)`
                : arg.value}
            </li>
          ))}
        </ul>
      )}
      <p className="break-all font-mono text-micro text-muted-foreground">Call data {callData}</p>
    </div>
  )
}

/**
 * A permission a managed agent asked for (ERC-7715 envelope, ADR-0015 draft). The operator may shorten the expiry or
 * lower the amount when the agent allowed it, reviews the template the server prepared against its own rebuild, and
 * signs the exact operator → agent delegation. Telegram links here; it never approves.
 */
export function PermissionApproval({
  approval,
  agent,
  operator,
  refresh,
}: {
  approval: AgentApproval
  agent: ManagedAgent
  operator: Address
  refresh: () => Promise<unknown>
}) {
  const request = permissionRequest(approval.request_json)
  const t = request.parsed
  const token = t.type === 'sidequest:contract-call' ? null : t.token
  const meta = token === null ? undefined : tokenMeta(token)
  useTokenList(token === null ? [] : [token])
  const { signTypedDataAsync } = useSignTypedData()
  const [limit, setLimit] = useState('')
  const [days, setDays] = useState('')
  const [standing, setStanding] = useState(request.standing)
  const [review, setReview] = useState<ReturnType<typeof reviewPermission> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requested =
    t.type === 'erc20-token-periodic' ? t.periodAmount : t.type === 'erc20-token-allowance' ? t.amount : null
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Decision is unavailable; retry')
    } finally {
      setBusy(false)
    }
  }
  /** The operator's adjustment in base units and unix seconds; empty fields keep the agent's request. */
  function adjustment(): { expiry?: number; amount?: bigint } {
    // An unknown token is entered in base units: guessing decimals would sign a different amount than shown.
    const lower =
      limit.trim() === '' || token === null
        ? undefined
        : meta === undefined
          ? BigInt(limit.trim())
          : parseUnits(limit.trim(), meta.decimals)
    const shorter = days.trim() === '' ? undefined : Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86_400)
    if (shorter !== undefined && !Number.isFinite(shorter)) throw new Error('Days must be a number')
    return {
      ...(lower === undefined ? {} : { amount: lower }),
      ...(shorter === undefined ? {} : { expiry: Math.min(shorter, request.expiry) }),
    }
  }
  async function prepare() {
    if (agent.address === null) throw new Error('This agent has no wallet yet')
    const adjust = adjustment()
    // Rebuild what this card agreed to before asking the server; a wider choice is refused here too.
    const final = expectedPermission(request, adjust)
    const prepared = await agentEndpoint<PreparedPermission>(`/api/approvals/${approval.id}/prepare`, 'POST', {
      ...(adjust.expiry === undefined ? {} : { expiry: adjust.expiry }),
      ...(adjust.amount === undefined ? {} : { amount: adjust.amount.toString() }),
    })
    const adjusted = final.expiry !== request.expiry || (adjust.amount !== undefined && adjust.amount !== requested)
    setReview(
      reviewPermission(deployment, prepared, {
        operator,
        agent: agent.address as Address,
        terms: final.terms,
        expiry: final.expiry,
        adjusted,
      }),
    )
  }
  async function decide(approved: boolean) {
    let body: Record<string, unknown> = { approved }
    if (approved) {
      if (review === null) throw new Error('Review the exact permission first')
      try {
        assertFreshAnchor(review.terms, review.start)
      } catch (stale) {
        setReview(null)
        throw stale
      }
      const signature = await signTypedDataAsync(typedDataArgs(review.typedData))
      body = { approved, signature, hash: review.hash, standing }
    }
    await agentEndpoint(`/api/approvals/${approval.id}/decide`, 'POST', body)
    setReview(null)
  }

  const shown = review?.description
  return (
    <Section title={`${agent.name} · Permission request`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xl font-semibold">{TYPE_WORDS[t.type] ?? t.type}</p>
        <Badge variant={approval.status === 'pending' ? 'warning' : 'neutral'}>{approval.status}</Badge>
      </div>
      {t.type === 'sidequest:contract-call' ? (
        <ExactCall target={t.target} value={t.value} callData={t.callData} />
      ) : (
        <p className="break-words text-sm leading-relaxed text-muted-foreground">
          Up to {tokenAmountText(shown !== undefined && 'amount' in shown ? shown.amount : requested!, t.token)}
          {t.type === 'erc20-token-periodic' ? ` every ${Math.round(t.periodDuration / 3600)} h` : ' in total'} from
          your wallet, only to {t.recipient}.
        </p>
      )}
      <p className="text-sm leading-relaxed text-muted-foreground">
        It ends {localTime(shown?.expiresAt ?? request.expiry)} ({relative(shown?.expiresAt ?? request.expiry)}). The
        chain enforces every limit.
      </p>
      {review?.schedule != null && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Periods count from {localTime(review.schedule.start)}; the first refill is{' '}
          {localTime(review.schedule.firstRefill)} ({relative(review.schedule.firstRefill)}).
        </p>
      )}
      {request.justification !== null && (
        <p className="break-words text-sm text-muted-foreground">
          Agent's reason (its own words): {request.justification}
        </p>
      )}
      <p className="break-all font-mono text-micro text-muted-foreground">Operation {approval.operation_id}</p>
      {approval.status === 'pending' && review === null && request.adjustable && (
        <div className="grid gap-3 sm:grid-cols-2">
          {token !== null && (
            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{`Lower the amount (${meta?.symbol ?? 'base units'})`}</span>
                <Input inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value)} />
              </FieldLabel>
              <FieldDescription>Empty keeps the request; you can only lower it.</FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel className="flex-col items-stretch">
              <span>End sooner (days from now)</span>
              <Input inputMode="decimal" value={days} onChange={(event) => setDays(event.target.value)} />
            </FieldLabel>
            <FieldDescription>Empty keeps the requested end.</FieldDescription>
          </Field>
        </div>
      )}
      {approval.status === 'pending' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={standing} onChange={(event) => setStanding(event.target.checked)} />
          Grant as a standing rule: later requests it covers are granted without asking you.
        </label>
      )}
      {review !== null && review.risks.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {review.risks.map((risk) => (
            <li key={risk.code}>
              <Badge variant={risk.level === 'high' ? 'destructive' : risk.level === 'medium' ? 'warning' : 'neutral'}>
                {risk.level}
              </Badge>{' '}
              {risk.message}
            </li>
          ))}
        </ul>
      )}
      {approval.status === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => void run(review === null ? prepare : () => decide(true))}>
            {review === null ? 'Review permission' : 'Sign and grant permission'}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void run(() => decide(false))}>
            Reject
          </Button>
        </div>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
