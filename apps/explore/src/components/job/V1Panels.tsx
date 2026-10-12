import { refreshJob } from '../../query-refresh.ts'
import { cn } from '../../lib/cn.ts'
import { Button } from '../ui/button.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Item, ItemGroup, ItemDescription, ItemContent, ItemActions } from '../ui/item.tsx'
import { Section, textLinkClass } from '../kit.tsx'
/**
 * What a Sidequest v1 job adds to its page (ADR-0011): before activation, the fee a worker would pay and what it would
 * receive, from `quoteActivation`; after activation, a top-up anyone can add to the reward. Both read and write the v1
 * Holding directly, in this file only, until the board's `fee_quote` and `top_up` tools land.
 */
import * as sdk from '@sidequest/sdk'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi } from 'viem'
import { useReadContracts } from 'wagmi'
import type { TxRequest } from '../../api.ts'
import { amount, tokenInfo } from '../../format.ts'
import { percent } from '../../stake.ts'
import { chain } from '../../wallet.ts'
import { toBase } from '../../format.ts'
import { useToast } from '../Sheet.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { AmountField } from '../money/AmountField.tsx'

/** Before activation: the viewer's fee tier and net payout if they activate now. */
export function FeeQuote({
  jobId,
  holding,
  viewer,
  token,
}: {
  jobId: string
  holding: Address
  viewer: Address
  token: string | null
}) {
  const quote = useReadContracts({
    contracts: [
      {
        address: holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'quoteActivation',
        args: [BigInt(jobId), viewer],
        chainId: chain.id,
      },
    ],
    query: { refetchInterval: 30_000 },
  })
  const r = quote.data?.[0]
  const [bps, fee, net] =
    r?.status === 'success' ? (r.result as readonly [number, bigint, bigint]) : [undefined, undefined, undefined]
  return (
    <Section
      title="If you take this job"
      note="Your fee rate is fixed when you activate: a later change of backing or schedule does not move it."
    >
      {quote.isError || r?.status === 'failure' ? (
        <Alert variant="destructive">
          <AlertDescription>Your fee for this job cannot be read from the chain right now.</AlertDescription>
        </Alert>
      ) : (
        <ItemGroup>
          <Item>
            <ItemContent className="flex-1">
              <span className="block">Sidequest’s fee{bps === undefined ? '' : ` · ${percent(Number(bps))}`}</span>
              <ItemDescription className="block text-xs leading-snug text-muted-foreground">
                Your rate, set by total backing
              </ItemDescription>
            </ItemContent>
            {/* min-w-24: the value's room is kept while it loads, so the label does not rewrap when it lands. */}
            <ItemActions className="tabular-nums min-w-24 flex-col items-end text-right text-muted-foreground">
              {fee === undefined ? (
                '…'
              ) : (
                <span>
                  − <TokenAmount value={fee} token={token} />
                </span>
              )}
            </ItemActions>
          </Item>
          <Item>
            <ItemContent className="flex-1 font-semibold">You receive</ItemContent>
            <ItemActions className="tabular-nums min-w-24 flex-col items-end text-right font-semibold">
              {net === undefined ? '…' : <TokenAmount value={net} token={token} />}
            </ItemActions>
          </Item>
          <Link to="/account" className={cn(textLinkClass, 'flex min-h-11 items-center px-4 text-sm')}>
            Back more to pay a lower fee
          </Link>
        </ItemGroup>
      )}
    </Section>
  )
}

/** After activation: anyone adds to the reward. Paid to the agent with it (same fee rate), or refundable. */
export function TopUp({
  boardId,
  jobId,
  holding,
  token,
  viewer,
}: {
  /** The board that lists the job, so its copies refresh after the top-up. */
  boardId: string
  jobId: string
  holding: Address
  token: Address
  viewer: Address
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const reads = useReadContracts({
    contracts: [
      {
        address: holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'getListing',
        args: [BigInt(jobId)],
        chainId: chain.id,
      },
      {
        address: holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'topUpOf',
        args: [BigInt(jobId), viewer],
        chainId: chain.id,
      },
    ],
    query: { refetchInterval: 30_000 },
  })
  const listing = reads.data?.[0]?.status === 'success' ? (reads.data[0].result as { bonus: bigint }) : undefined
  const mine = reads.data?.[1]?.status === 'success' ? (reads.data[1].result as bigint) : undefined
  const [text, setText] = useState('')
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const value = text.trim() === '' ? null : toBase(text, token)
  const valid = value !== null && value > 0n
  const add = () => {
    if (!valid || value === null) return
    setTxs([
      {
        description: `Approve ${amount(value.toString(), token)} for the job`,
        chainId: chain.id,
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [holding, value] }),
        value: '0',
      },
      {
        description: `Add ${amount(value.toString(), token)} to job #${jobId}`,
        chainId: chain.id,
        to: holding,
        data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'topUp', args: [BigInt(jobId), value] }),
        value: '0',
      },
    ])
    setText('')
  }
  return (
    <Section
      title="Add to the reward"
      note="Anyone can add to the reward while the job is under way. The agent is paid it with the reward, minus the same fee rate. If the creator is refunded instead, each contributor can claim their top-up back."
    >
      <ItemGroup>
        <Item>
          <ItemContent className="flex-1">Added so far</ItemContent>
          {listing === undefined ? <span>…</span> : <TokenAmount value={listing.bonus} token={token} />}
        </Item>
        {mine !== undefined && mine > 0n && (
          <Item>
            <ItemContent className="flex-1 text-muted-foreground">By you</ItemContent>
            <ItemContent className="text-muted-foreground">
              <TokenAmount value={mine} token={token} />
            </ItemContent>
          </Item>
        )}
      </ItemGroup>
      {txs !== null ? (
        <div className="mt-2">
          <TxSteps
            key={txs.map((t) => t.data).join()}
            taskId={`topup:${jobId}`}
            txs={txs}
            owner={viewer}
            reportToBoard={false}
            onDone={() => {
              setTxs(null)
              void refreshJob(qc, { boardId, jobId })
              toast('Added to the reward')
            }}
          />
        </div>
      ) : (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <AmountField
            label="Amount to add"
            value={text}
            onChange={setText}
            token={token}
            symbol={tokenInfo(token).symbol}
          />
          <Button type="submit" variant="secondary" disabled={!valid} className="w-fit">
            Add to the reward
          </Button>
        </form>
      )}
    </Section>
  )
}
