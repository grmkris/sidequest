import { publicKey } from '../../queries.ts'
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { getAddress, decodeFunctionData } from 'viem'
import type { TxRequest } from '../../api.ts'
import { formatNumber } from '../../format.ts'
import { stakeContext } from '../../stake-context.ts'
import { friendlyError } from '../../txErrors.ts'
import {
  freezePosting,
  postingPublish,
  savePosting,
  type FrozenPosting,
  loadPosting,
  postingPolicyError,
  updatePostingPolicy,
} from '../../posting-funding.ts'
import { TxSteps } from '../TxSteps.tsx'
import { usePrivyBatch } from '../Privy.tsx'
import { withWalletStepLock } from '../txOperation.ts'
import { emptyJournal, txJournalKey } from '../txJournal.ts'
import { Button } from '../ui/button.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Link } from '@tanstack/react-router'
import { isMainnet } from '../../wallet.ts'

interface Props {
  taskId: string
  txs: TxRequest[]
  owner: string
  boardId?: string
  canSend?: boolean
  onDone: (hashes: string[]) => void
}

export function PostingSteps(props: Props) {
  const ctx = stakeContext()
  try {
    const publish = postingPublish(ctx, props.txs)
    const key = `bond-funding:${ctx.deployment.chainId}:${ctx.stack.holding}:${props.owner.toLowerCase()}:${props.taskId}`
    return <PostingReview key={`${key}:${publish.data}`} {...props} ctx={ctx} publish={publish} fundingKey={key} />
  } catch (cause) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{friendlyError(cause)}</AlertDescription>
      </Alert>
    )
  }
}

type ReviewProps = Props & { ctx: sdk.Ctx; publish: TxRequest; fundingKey: string }

function usePostingState({ taskId, owner, ctx, publish, fundingKey }: ReviewProps) {
  const [frozen, setFrozen] = useState<FrozenPosting | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void loadPosting(localStorage, fundingKey, taskId, publish)
      .then((saved) => {
        if (live) {
          setFrozen(saved)
          setHydrated(true)
        }
      })
      .catch((cause) => {
        if (live) {
          setError(friendlyError(cause))
          setHydrated(true)
        }
      })
    return () => {
      live = false
    }
  }, [fundingKey, taskId, publish])
  const plan = useQuery({
    queryKey: publicKey('bond-funding', fundingKey, publish.data),
    enabled: hydrated && error === null && frozen === null,
    queryFn: () => sdk.preparePublishFunding(ctx, getAddress(owner), publish),
    retry: false,
  })
  return { frozen, setFrozen, hydrated, error, setError, busy, setBusy, plan }
}

async function validateBeforeSend(props: ReviewProps, frozen: FrozenPosting | null) {
  const { ctx, fundingKey, taskId, publish } = props
  const saved = await loadPosting(localStorage, fundingKey, taskId, publish)
  if (saved === null || JSON.stringify(saved) !== JSON.stringify(frozen))
    return 'The funding review changed. Reload before continuing.'
  const problem = postingPolicyError(saved, await sdk.readBondPolicy(ctx))
  if (problem !== null) return problem
  const block = await ctx.publicClient.getBlock()
  const call = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: publish.data })
  if (call.functionName !== 'publish') return 'Expected a publish call.'
  const decoded = call.args[0]
  if (decoded.deliveryDeadline <= Number(block.timestamp)) return 'The delivery deadline passed. Prepare a new offer.'
  await sdk.requireFundingAdmission(ctx, getAddress(props.owner))
  await sdk.requireBondHorizon(ctx, decoded.expiredAt, decoded.creatorBond, decoded.workerBond)
  return null
}

function usePostingActions(props: ReviewProps, state: ReturnType<typeof usePostingState>) {
  const { ctx, fundingKey, taskId, publish, owner } = props
  const walletBatch = usePrivyBatch(getAddress(owner))
  const perform = async (action: () => Promise<FrozenPosting>) => {
    state.setBusy(true)
    try {
      const next = await withWalletStepLock(navigator.locks, fundingKey, action)
      state.setFrozen(next)
      state.setError(null)
    } catch (cause) {
      state.setError(friendlyError(cause))
    } finally {
      state.setBusy(false)
    }
  }
  const review = () =>
    perform(async () => {
      const existing = await loadPosting(localStorage, fundingKey, taskId, publish)
      if (existing !== null) return existing
      const latest = await sdk.preparePublishFunding(ctx, getAddress(owner), publish)
      if (latest.sideShortfall > 0n) throw new Error('Add liquid SIDE for backing and review again')
      const next = freezePosting(publish, latest)
      await savePosting(localStorage, fundingKey, taskId, next, {
        journal: { ...emptyJournal(), batch: walletBatch !== null },
      })
      return next
    })
  const reviewPolicy = () =>
    perform(async () => {
      const saved = await loadPosting(localStorage, fundingKey, taskId, publish)
      if (saved === null) throw new Error('Reload the saved funding review before continuing.')
      const next = updatePostingPolicy(saved, await sdk.readBondPolicy(ctx))
      await savePosting(localStorage, fundingKey, taskId, next, { journal: emptyJournal() })
      return next
    })
  return { review, reviewPolicy, sendGuard: () => validateBeforeSend(props, state.frozen) }
}

function PostingAmounts({ amounts }: { amounts: FrozenPosting }) {
  return (
    <>
      <p className="text-sm">
        Creator bond reserved: {formatNumber(BigInt(amounts.creatorBond), 18)} SIDE from backing.
      </p>
      <p className="text-sm">
        If nobody activates this job, {amounts.unfilledForfeitBps / 100}% (
        {formatNumber((BigInt(amounts.creatorBond) * BigInt(amounts.unfilledForfeitBps)) / 10_000n, 18)} SIDE) goes to
        the treasury when it ends. Free cancel strictly within {amounts.cancelGrace / 60} minutes of publish. Expiry
        always forfeits. The policy in effect when publication confirms determines the job's snapshotted rate.
      </p>
      <p className="text-sm text-muted-foreground">
        {BigInt(amounts.deposit) > 0n
          ? `Add ${formatNumber(BigInt(amounts.deposit), 18)} SIDE of backing owned by your wallet. It shares penalty exposure and withdrawal cooldowns.`
          : 'Your available backing covers the bond.'}
      </p>
      {BigInt(amounts.shortfall) > 0n && (
        <p className="text-sm">
          You need {formatNumber(BigInt(amounts.shortfall), 18)} more liquid SIDE for backing.{' '}
          {!isMainnet && <Link to="/account">Get test tokens on your Account page.</Link>}
        </p>
      )}
      <p className="text-sm">
        <Link to="/account">Manage backing</Link> if your available stake changes before publishing.
      </p>
    </>
  )
}

function PostingReview(props: ReviewProps) {
  const { taskId, owner, boardId, canSend = true, onDone, publish } = props
  const state = usePostingState(props)
  const { frozen, hydrated, busy, error, plan } = state
  const { review, reviewPolicy, sendGuard } = usePostingActions(props, state)
  const amounts = frozen ?? (plan.data === undefined ? null : freezePosting(publish, plan.data))
  return (
    <div className="grid gap-3">
      {amounts !== null && <PostingAmounts amounts={amounts} />}
      {amounts !== null && frozen === null && (
        <>
          <Button
            busy={busy}
            disabled={!canSend || error !== null || BigInt(amounts.shortfall) > 0n}
            onClick={() => void review()}
          >
            Review wallet steps
          </Button>
          <Button variant="ghost" onClick={() => void plan.refetch()}>
            Refresh balances
          </Button>
        </>
      )}
      {frozen !== null && (
        <>
          <Button variant="ghost" busy={busy} disabled={!canSend} onClick={() => void reviewPolicy()}>
            Review current bond terms
          </Button>
          <TxSteps
            key={txJournalKey(taskId, frozen.transactions)}
            taskId={taskId}
            txs={frozen.transactions}
            owner={owner}
            boardId={boardId}
            canSend={canSend && !busy}
            allowSponsorship={false}
            requireJournal
            durableJournal
            verifyReceipt
            retainRecord
            sendGuard={sendGuard}
            onDone={onDone}
          />
        </>
      )}
      {(!hydrated || plan.isLoading) && <p>Reading bond policy and backing…</p>}
      {(error !== null || plan.isError) && (
        <Alert variant="destructive">
          <AlertDescription>{error ?? friendlyError(plan.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
