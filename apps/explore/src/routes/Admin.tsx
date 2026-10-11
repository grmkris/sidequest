import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { ItemGroup, Item, ItemContent, ItemActions, ItemDescription } from '../components/ui/item.tsx'
import { Address as AddressText, LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import * as sdk from '@sidequest/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useMemo, useState } from 'react'
import { type Abi, type Address, type Hex, isAddress, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { getBytecode } from 'wagmi/actions'
import { type TxRequest } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'
import { useToast } from '../components/Sheet.tsx'
import { Countdown, When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'

import { useAuth } from '../components/Wallet.tsx'
import { formatNumber } from '../format.ts'
import { type AdminContext, type AdminTx, readAdminOp, scheduleProposal } from '../admin.ts'
import { type SidequestContracts, sidequest } from '../sidequest.ts'
import { MULTI_SEND_CALL_ONLY, type Call, atomically, calldata, execTransaction, safeAbi } from '../safe.ts'
import { percent, proposalState } from '../stake.ts'
import { chain, deployed, deployment, wagmiConfig } from '../wallet.ts'
import { duration } from '../duration.ts'

const fmt = (wei: bigint) => `${formatNumber(wei, 18)} SIDE`
const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
const result = <T,>(data: ReadonlyArray<{ status: string; result?: unknown }> | undefined, i: number): T | undefined =>
  data?.[i]?.status === 'success' ? (data[i]?.result as T) : undefined

/**
 * Whether `address` owns the Safe that owns Sidequest v1: null while unknown (not deployed, loading or unreadable), so
 * a caller shows nothing rather than guessing.
 */
export function useSafeOwner(address: string | undefined): boolean | null {
  const owners = useReadContracts({
    contracts: [{ address: sidequest.safe, abi: safeAbi, functionName: 'getOwners', chainId: chain.id }],
    query: { enabled: deployed && address !== undefined, staleTime: 60_000 },
  })
  const list = result<readonly Address[]>(owners.data, 0)
  if (address === undefined || list === undefined) return null
  return list.some((o) => same(o, address))
}

type Via = 'safe' | 'direct'
/**
 * What the page will send: its transactions, kept until they are done. Every call shown or sent is decoded from their
 * calldata and checked again (`readAdminOp`), so a stored draft is never trusted.
 */
interface Op {
  title: string
  txs: TxRequest[]
}
const opKey = (me: string) => `sidequest.admin-op:${me.toLowerCase()}`
function loadOp(me: string): Omit<Op, 'title'> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(opKey(me)) ?? 'null') as { txs?: unknown } | null
    if (saved === null || !Array.isArray(saved.txs)) return null
    return { txs: saved.txs as TxRequest[] }
  } catch {
    return null
  }
}
function saveOp(me: string, op: Op | null) {
  try {
    if (op === null) localStorage.removeItem(opKey(me))
    else localStorage.setItem(opKey(me), JSON.stringify({ txs: op.txs }))
  } catch {
    // storage blocked: the operation lasts as long as the page
  }
}

/**
 * The contracts this console calls, from the deployment config, with what it sends to each as the Safe and what it
 * sends directly (permissionless). Every transaction is held to this before it is shown or sent.
 */
const target = (name: string, abi: unknown, asSafe: string[], direct: string[] = []) => ({
  name,
  abi: abi as Abi,
  safe: ['acceptOwnership', ...asSafe],
  direct,
})
function adminContext(c: SidequestContracts, safe: Address, me: Address): AdminContext {
  return {
    chainId: chain.id,
    safe,
    owner: me,
    targets: {
      [c.feeSchedule.toLowerCase()]: target('FeeSchedule', sdk.feeScheduleAbi, ['propose', 'cancel'], ['execute']),
      [c.vault.toLowerCase()]: target(
        'StakeVault',
        sdk.stakeVaultAbi,
        ['proposeHolding', 'cancelHoldingProposal', 'revokeHolding'],
        ['acceptHolding'],
      ),
      [c.holding.toLowerCase()]: target('SidequestHolding', sdk.sidequestHoldingAbi, []),
      [c.evaluator.toLowerCase()]: target(
        'SidequestEvaluator',
        sdk.sidequestEvaluatorAbi,
        ['notePause'],
        ['notePause'],
      ),
      [c.miningReserve.toLowerCase()]: target('MiningReserve', sdk.miningReserveAbi, []),
      [c.distributor.toLowerCase()]: target('EpochDistributor', sdk.epochDistributorAbi, []),
      [deployment.core.toLowerCase()]: {
        name: 'Core',
        abi: sdk.coreAbi as unknown as Abi,
        safe: ['pause', 'unpause'],
        direct: [],
      },
    },
  }
}

/** A title read from the calls themselves, for a draft restored from storage. */
const titleOf = (reads: AdminTx[]) =>
  reads.flatMap((r) => (r.ok ? r.calls.map((x) => `${x.contract}.${x.functionName}`) : [])).join(' + ') +
  (reads.some((r) => r.ok && r.via !== 'direct') ? ' as the Safe' : '')

/**
 * `act(title, call, via)`: show a call for review; `busy` while one is under review or being sent. Several calls
 * (`[pause, notePause]`) go as the Safe in ONE `execTransaction` through MultiSendCallOnly: both happen or neither
 * (D13), whatever the wallet; there is no sequential fallback.
 */
type Act = (title: string, call: Call | readonly Call[], via: Via) => void

/**
 * The Safe's console (ADR-0011). Shown only to an owner of the Safe that owns Sidequest v1; the Safe's threshold is 1,
 * so the owner's wallet calls `execTransaction` itself with a pre-validated signature. Every action shows the exact
 * call, decoded from the calldata that will be sent, before the wallet opens. Permissionless steps (executing a fee
 * schedule, accepting a Holding after its delay) go straight from the wallet.
 */
export function AdminPage() {
  const auth = useAuth()
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle>Admin</PageTitle>

        <section className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover">
          <h2 className="text-xl leading-tight font-bold tracking-tight">Sign in as a Safe owner</h2>
          <div>
            <PrivyLogin />
          </div>
        </section>
      </>
    )
  }
  return <Gate c={sidequest} safe={sidequest.safe} me={auth.address as Address} />
}

function Gate({ c, safe, me }: { c: SidequestContracts; safe: Address; me: Address }) {
  const reads = useReadContracts({
    contracts: [
      { address: safe, abi: safeAbi, functionName: 'getOwners', chainId: chain.id },
      { address: safe, abi: safeAbi, functionName: 'getThreshold', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const owners = result<readonly Address[]>(reads.data, 0)
  const threshold = result<bigint>(reads.data, 1)
  if (reads.isLoading)
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <LoadingRows rows={3} />
      </>
    )
  if (owners === undefined || threshold === undefined) {
    return (
      <>
        <PageTitle>Admin</PageTitle>

        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
          <p>The Safe's owners cannot be read from the chain right now.</p>
          <Button variant="secondary" onClick={() => void reads.refetch()}>
            Retry
          </Button>
        </div>
      </>
    )
  }
  if (!owners.some((o) => same(o, me))) {
    return (
      <>
        <PageTitle>Admin</PageTitle>

        <Empty>
          <EmptyHeader>
            <EmptyTitle>{"Only the Safe's owners see this"}</EmptyTitle>
            <EmptyDescription>This wallet is not an owner of the Safe that owns Sidequest v1.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }
  if (threshold !== 1n) {
    return (
      <>
        <PageTitle>Admin</PageTitle>

        <Empty>
          <EmptyHeader>
            <EmptyTitle>{`The Safe needs ${threshold} signatures`}</EmptyTitle>
            <EmptyDescription>
              This console sends as a single owner (threshold 1). With a higher threshold, use the Safe's own app.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }
  return <Admin c={c} safe={safe} me={me} />
}

function Admin({ c, safe, me }: { c: SidequestContracts; safe: Address; me: Address }) {
  const qc = useQueryClient()
  const toast = useToast()
  const ctx = useMemo(() => adminContext(c, safe, me), [c, safe, me])
  const [op, setOpState] = useState<Op | null>(() => {
    const saved = loadOp(me)
    return saved === null ? null : { title: titleOf(readAdminOp(saved.txs, ctx)), ...saved }
  })
  const [dismissable, setDismissable] = useState(true)
  const setOp = (next: Op | null) => {
    saveOp(me, next)
    setOpState(next)
  }
  // MultiSendCallOnly must have code here before a pause pair is sent through it (D13).
  const multiSendCode = useQuery({
    queryKey: ['bytecode', chain.id, MULTI_SEND_CALL_ONLY],
    queryFn: async () => (await getBytecode(wagmiConfig, { address: MULTI_SEND_CALL_ONLY, chainId: chain.id })) ?? '0x',
    staleTime: 300_000,
    retry: false,
  })
  const atomicReady = multiSendCode.data !== undefined && multiSendCode.data !== '0x'
  const act: Act = (title, call, via) => {
    const tx: TxRequest = Array.isArray(call)
      ? {
          description: `${call.map((x) => `${x.contract}.${x.functionName}`).join(' + ')} as the Safe, in one transaction`,
          chainId: chain.id,
          to: safe,
          data: atomically(
            me,
            call.map((x) => ({ to: x.to, data: calldata(x) })),
          ),
          value: '0',
        }
      : (() => {
          const one = call as Call
          const data = calldata(one)
          return via === 'safe'
            ? {
                description: `${one.contract}.${one.functionName} as the Safe`,
                chainId: chain.id,
                to: safe,
                data: execTransaction(me, { to: one.to, data }),
                value: '0',
              }
            : { description: `${one.contract}.${one.functionName}`, chainId: chain.id, to: one.to, data, value: '0' }
        })()
    setOp({ title, txs: [tx] })
    window.scrollTo({ top: 0 })
  }
  // What is shown and sent is read back from the calldata on every render, the same for a fresh and a restored op.
  const reads = op === null ? [] : readAdminOp(op.txs, ctx)
  const refused = reads.find((r) => !r.ok)
  const atomic = reads.some((r) => r.ok && r.via === 'atomic')
  const blocked =
    refused !== undefined
      ? null
      : atomic && !atomicReady
        ? multiSendCode.isLoading
          ? 'Checking MultiSendCallOnly on this network…'
          : `MultiSendCallOnly has no code at ${MULTI_SEND_CALL_ONLY} on this network, so these calls cannot go as one transaction. Nothing is sent.`
        : null
  const busy = op !== null
  return (
    <>
      <PageTitle
        sub={
          <span>
            As the Safe <AddressText value={safe} /> · threshold 1
          </span>
        }
      >
        Admin
      </PageTitle>

      {op !== null && refused !== undefined && !refused.ok && (
        <Section title="Saved operation refused">
          <div role="alert" className="grid gap-2 rounded-xl bg-destructive/12 p-4 text-sm text-destructive-text">
            <p>
              A saved admin operation does not read as one this console sends for this Safe and wallet:{' '}
              {refused.problem} It was not sent.
            </p>
            <Button variant="destructive" onClick={() => setOp(null)}>
              Discard it
            </Button>
          </div>
        </Section>
      )}

      {op !== null && refused === undefined && (
        <Section title="Review and send" note="This is exactly what your wallet will send, decoded from its calldata.">
          <Review title={op.title} reads={reads} safe={safe} />
          {blocked !== null && (
            <Alert variant="destructive">
              <AlertDescription>{blocked}</AlertDescription>
            </Alert>
          )}
          <div className="mt-3">
            <TxSteps
              key={op.txs.map((x) => x.data).join()}
              taskId={`admin:${me.toLowerCase()}`}
              txs={op.txs}
              owner={me}
              canSend={blocked === null}
              reportToBoard={false}
              onSafeToRestartChange={setDismissable}
              onDone={() => {
                const title = op.title
                setOp(null)
                void qc.invalidateQueries()
                toast(`${title}: done`)
              }}
            />
          </div>
          {dismissable && (
            <Button variant="link" size="sm" className="mt-2 justify-self-center" onClick={() => setOp(null)}>
              Not now
            </Button>
          )}
        </Section>
      )}

      <Ownership c={c} safe={safe} act={act} busy={busy} />

      <Core c={c} safe={safe} act={act} busy={busy} atomicReady={atomicReady} />

      <Fees c={c} act={act} busy={busy} />

      <Holdings c={c} act={act} busy={busy} />
    </>
  )
}

function Review({ title, reads, safe }: { title: string; reads: AdminTx[]; safe: Address }) {
  return (
    <div className="grid gap-3 rounded-xl bg-card px-4 py-3.5">
      <p className="font-semibold">{title}</p>
      {reads.map((r, i) => (r.ok ? <TxReview key={i} read={r} safe={safe} /> : null))}
    </div>
  )
}

function TxReview({ read, safe }: { read: Extract<AdminTx, { ok: true }>; safe: Address }) {
  return (
    <div className="grid gap-3">
      {read.via === 'atomic' && (
        <p className="text-sm text-muted-foreground">
          One Safe transaction: the Safe delegatecalls MultiSendCallOnly v1.4.1{' '}
          <code className="font-mono break-all">{MULTI_SEND_CALL_ONLY}</code>, which makes these {read.calls.length}{' '}
          calls in order. Both happen, or neither.
        </p>
      )}
      {read.calls.map((call, i) => (
        <div key={i} className="grid gap-2">
          {read.calls.length > 1 && (
            <p className="text-ui font-semibold tracking-wide text-muted-foreground uppercase">Call {i + 1}</p>
          )}
          <ItemGroup className="bg-background">
            <KV k="Contract" stack>
              {call.contract} <code className="font-mono text-ui break-all">{call.to}</code>
            </KV>
            <KV k="Function" stack>
              <code className="font-mono text-ui">
                {call.functionName}({call.args.map(([name]) => name).join(', ')})
              </code>
            </KV>
            {call.args.map(([name, value]) => (
              <KV key={name} k={name} stack>
                <code className="font-mono text-ui break-all">{value}</code>
              </KV>
            ))}
            <KV k="Calldata" stack>
              <code className="font-mono text-xs break-all text-muted-foreground">{call.data}</code>
            </KV>
          </ItemGroup>
        </div>
      ))}
      {read.outer !== null ? (
        <>
          <p className="text-sm text-muted-foreground">
            Sent as the Safe <AddressText value={safe} />: your wallet calls its{' '}
            <code className="font-mono">execTransaction</code> with your owner signature (r = you, s = 0, v = 1).
          </p>

          <ItemGroup className="bg-background">
            {read.outer.map(([name, value]) => (
              <KV key={name} k={name} stack>
                <code className="font-mono text-ui break-all">{value}</code>
              </KV>
            ))}
          </ItemGroup>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Anyone may send this call; it goes straight from your wallet, not through the Safe.
        </p>
      )}
    </div>
  )
}

/** A labelled value; `stack` puts the label above, for long values (hex, structs) that must stay whole. */
function KV({ k, children, stack = false }: { k: string; children: ReactNode; stack?: boolean }) {
  if (stack) {
    return (
      <Item>
        <ItemContent className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-ui text-muted-foreground">{k}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        </ItemContent>
      </Item>
    )
  }
  return (
    <Item>
      <ItemContent className="w-24 shrink-0 text-ui text-muted-foreground sm:w-32">{k}</ItemContent>
      <ItemActions className="min-w-0 flex-1 flex-col items-end text-right [overflow-wrap:anywhere]">
        {children}
      </ItemActions>
    </Item>
  )
}

function Unavailable({ retry }: { retry: () => void }) {
  return (
    <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
      <p>These facts cannot be read from the chain right now.</p>
      <Button variant="secondary" onClick={retry}>
        Retry
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Ownership: every Ownable2Step contract should be owned by the Safe; right after deploy it is pending and the Safe
// accepts. The first admin smoke test.
// ---------------------------------------------------------------------------------------------------------------

function Ownership({ c, safe, act, busy }: { c: SidequestContracts; safe: Address; act: Act; busy: boolean }) {
  const owned: Array<[string, Address, Abi]> = [
    ['FeeSchedule', c.feeSchedule, sdk.feeScheduleAbi],
    ['StakeVault', c.vault, sdk.stakeVaultAbi],
    ['SidequestHolding', c.holding, sdk.sidequestHoldingAbi],
    ['SidequestEvaluator', c.evaluator, sdk.sidequestEvaluatorAbi],
    ['MiningReserve', c.miningReserve, sdk.miningReserveAbi],
    ['EpochDistributor', c.distributor, sdk.epochDistributorAbi],
  ]
  const reads = useReadContracts({
    contracts: owned.flatMap(([, address, abi]) => [
      { address, abi, functionName: 'owner', chainId: chain.id },
      { address, abi, functionName: 'pendingOwner', chainId: chain.id },
    ]),
    query: { refetchInterval: 30_000 },
  })
  return (
    <Section
      title="Ownership"
      note="Each contract is owned by the Safe. After a deploy or a handover, the Safe accepts each one here."
    >
      {reads.isError ? (
        <Unavailable retry={() => void reads.refetch()} />
      ) : (
        <ItemGroup>
          {owned.map(([name, address, abi], i) => {
            const owner = result<Address>(reads.data, i * 2)
            const pending = result<Address>(reads.data, i * 2 + 1)
            return (
              <Item key={name}>
                <ItemContent className="min-w-0 flex-1">
                  {name}
                  <ItemDescription className="block text-xs text-muted-foreground">
                    <AddressText value={address} />
                  </ItemDescription>
                </ItemContent>
                {owner === undefined ? (
                  <span className="text-muted-foreground">—</span>
                ) : same(owner, safe) ? (
                  <Badge variant="success">Safe owns it</Badge>
                ) : same(pending, safe) ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(
                        `Accept ownership of ${name}`,
                        { contract: name, to: address, abi, functionName: 'acceptOwnership' },
                        'safe',
                      )
                    }
                  >
                    Accept ownership
                  </Button>
                ) : (
                  <span className="grid justify-items-end gap-0.5 text-ui">
                    <Badge variant="warning">Not the Safe</Badge>
                    <AddressText value={owner} />
                  </span>
                )}
              </Item>
            )
          })}
        </ItemGroup>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Core: pause and unpause (ADMIN_ROLE). On testnet the core is reused and its admin may not be the Safe.
// ---------------------------------------------------------------------------------------------------------------

function Core({
  c,
  safe,
  act,
  busy,
  atomicReady,
}: {
  c: SidequestContracts
  safe: Address
  act: Act
  busy: boolean
  atomicReady: boolean
}) {
  const core = deployment.core
  const base = useReadContracts({
    contracts: [
      { address: core, abi: sdk.coreAbi, functionName: 'paused', chainId: chain.id },
      { address: core, abi: sdk.coreAbi, functionName: 'ADMIN_ROLE', chainId: chain.id },
      { address: c.evaluator, abi: sdk.sidequestEvaluatorAbi, functionName: 'pauseCount', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const paused = result<boolean>(base.data, 0)
  const role = result<Hex>(base.data, 1)
  const count = result<bigint>(base.data, 2)
  // The Evaluator's pause history is append-only (C9-007): the latest interval is open while its end is 0.
  const latest = useReadContracts({
    contracts: [
      {
        address: c.evaluator,
        abi: sdk.sidequestEvaluatorAbi,
        functionName: 'pauseAt',
        args: [count !== undefined && count > 0n ? count - 1n : 0n],
        chainId: chain.id,
      },
    ],
    query: { enabled: count !== undefined && count > 0n, refetchInterval: 30_000 },
  })
  const interval = result<{ start: number; end: number }>(latest.data, 0)
  const admin = useReadContracts({
    contracts: [
      {
        address: core,
        abi: sdk.coreAbi,
        functionName: 'hasRole',
        args: [role ?? `0x${'0'.repeat(64)}`, safe],
        chainId: chain.id,
      },
    ],
    query: { enabled: role !== undefined },
  })
  const safeIsAdmin = result<boolean>(admin.data, 0)
  const call = (functionName: 'pause' | 'unpause'): Call => ({
    contract: 'Core',
    to: core,
    abi: sdk.coreAbi as unknown as Abi,
    functionName,
  })
  // D4b: the Evaluator records the pause, so a delivery deadline that falls inside it is never slashed. It goes in the
  // same send as the pause or unpause; anyone may also send it alone when the two have drifted apart.
  const note: Call = {
    contract: 'SidequestEvaluator',
    to: c.evaluator,
    abi: sdk.sidequestEvaluatorAbi as unknown as Abi,
    functionName: 'notePause',
  }
  const noted =
    count === undefined
      ? undefined
      : count === 0n
        ? false
        : interval === undefined
          ? undefined
          : Number(interval.end) === 0
  const drift = paused !== undefined && noted !== undefined && paused !== noted
  return (
    <Section
      title="Core"
      note="Pausing stops every call on the job core: nothing can be funded, delivered or paid. The Evaluator notes the pause in the same send, so a delivery deadline inside it is never slashed."
    >
      {base.isError || admin.isError || latest.isError ? (
        <Unavailable retry={() => void Promise.all([base.refetch(), admin.refetch(), latest.refetch()])} />
      ) : (
        <div className="grid gap-3 rounded-xl bg-card px-4 py-3.5">
          <p className="flex flex-wrap items-center gap-2">
            {paused === undefined ? (
              '—'
            ) : paused ? (
              <Badge variant="destructive">Paused</Badge>
            ) : (
              <Badge variant="success">Running</Badge>
            )}
            <span className="text-ui text-muted-foreground">
              <AddressText value={core} />
            </span>
          </p>
          {drift && (
            <div className="grid gap-2 rounded-xl bg-warning/14 p-3 text-sm text-warning-text">
              <p>
                {paused
                  ? 'The Evaluator has not noted this pause: a worker whose delivery deadline falls inside it could be slashed.'
                  : 'The Evaluator still counts the core as paused.'}
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(paused ? 'Note the pause on the Evaluator' : 'Note the unpause on the Evaluator', note, 'direct')
                }
              >
                {paused ? 'Note the pause' : 'Note the unpause'}
              </Button>
            </div>
          )}
          {!atomicReady && safeIsAdmin !== false && (
            <p className="text-sm text-muted-foreground">
              Pausing waits for MultiSendCallOnly to be confirmed on this network: the pause and its note go as one
              transaction or not at all.
            </p>
          )}
          {safeIsAdmin === false ? (
            <p className="text-sm text-muted-foreground">
              The Safe is not the core's admin on this network, so it cannot pause it from here.
            </p>
          ) : (
            <Button
              variant={paused === true ? 'default' : 'destructive'}
              disabled={busy || paused === undefined || safeIsAdmin !== true || !atomicReady}
              onClick={() =>
                act(
                  paused === true ? 'Unpause the core' : 'Pause the core',
                  [call(paused === true ? 'unpause' : 'pause'), note],
                  'safe',
                )
              }
            >
              {paused === true ? 'Unpause the core' : 'Pause the core'}
            </Button>
          )}
        </div>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// FeeSchedule: propose, then anyone executes after the chain's delay; the Safe can cancel.
// ---------------------------------------------------------------------------------------------------------------

type Schedule = { thresholds: readonly bigint[]; bps: readonly number[]; treasury: Address }

function Fees({ c, act, busy }: { c: SidequestContracts; act: Act; busy: boolean }) {
  const now = useNow()
  const reads = useReadContracts({
    contracts: [
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'schedule', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'pending', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'DELAY', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'MAX_BPS', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'PROPOSAL_GRACE', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const current = result<Schedule>(reads.data, 0)
  const pendingRead = result<readonly [Schedule, number]>(reads.data, 1)
  const delay = result<number>(reads.data, 2)
  const maxBps = result<number>(reads.data, 3)
  const feeGrace = result<number>(reads.data, 4)
  const pending =
    pendingRead !== undefined && Number(pendingRead[1]) !== 0
      ? { ...pendingRead[0], eta: Number(pendingRead[1]) }
      : null
  const [draft, setDraft] = useState<{ thresholds: string[]; rates: string[]; treasury: string } | null>(null)
  const form =
    draft ??
    (current === undefined
      ? null
      : {
          thresholds: current.thresholds.map((t) => formatNumber(t, 18).replaceAll(',', '')),
          rates: current.bps.map((b) => String(b / 100)),
          treasury: current.treasury,
        })
  const proposal = form === null || maxBps === undefined ? null : scheduleProposal(form, Number(maxBps))
  const fee = (call: Omit<Call, 'contract' | 'to' | 'abi'>): Call => ({
    contract: 'FeeSchedule',
    to: c.feeSchedule,
    abi: sdk.feeScheduleAbi,
    ...call,
  })
  const timing =
    delay === undefined
      ? 'The fee-change delay cannot be read from the chain right now.'
      : `A change takes effect ${duration(Number(delay))} after it is proposed, when anyone executes it.`

  return (
    <Section title="Fee schedule" note={`${timing} Jobs keep the rate they were activated with.`}>
      {reads.isError ? (
        <Unavailable retry={() => void reads.refetch()} />
      ) : current === undefined ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="grid gap-3">
          <ScheduleTable title="In force" schedule={current} />
          {pending !== null && (
            <div className="grid gap-2 rounded-xl bg-primary/10 px-4 py-3.5">
              <ScheduleTable title="Proposed" schedule={pending} />
              <Expiry eta={pending.eta} now={now} grace={feeGrace} verb="Executable" />
              <div className="flex flex-wrap gap-2">
                <Button
                  className="flex-1"
                  disabled={
                    busy || feeGrace === undefined || proposalState(pending.eta, now, Number(feeGrace)) !== 'open'
                  }
                  onClick={() => act('Execute the proposed fee schedule', fee({ functionName: 'execute' }), 'direct')}
                >
                  Execute
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => act('Cancel the proposed fee schedule', fee({ functionName: 'cancel' }), 'safe')}
                >
                  Cancel proposal
                </Button>
              </div>
            </div>
          )}
          {form !== null && (
            <form
              className="grid gap-3 rounded-xl bg-card px-4 py-3.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (proposal === null || typeof proposal === 'string') return
                act('Propose a new fee schedule', fee({ functionName: 'propose', args: [proposal] }), 'safe')
              }}
            >
              <p className="font-semibold">Propose a schedule</p>
              {form.thresholds.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_6rem] items-end gap-2">
                  <label className="grid gap-1">
                    <span className="text-ui text-muted-foreground">Tier {i + 1} from (SIDE)</span>
                    <Input
                      aria-label={`Tier ${i + 1} threshold`}
                      value={t}
                      inputMode="decimal"
                      className="tabular-nums"
                      onChange={(e) =>
                        setDraft({ ...form, thresholds: form.thresholds.map((x, j) => (j === i ? e.target.value : x)) })
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-ui text-muted-foreground">Fee %</span>
                    <Input
                      aria-label={`Tier ${i + 1} fee`}
                      value={form.rates[i] ?? ''}
                      inputMode="decimal"
                      className="tabular-nums"
                      onChange={(e) =>
                        setDraft({ ...form, rates: form.rates.map((x, j) => (j === i ? e.target.value : x)) })
                      }
                    />
                  </label>
                </div>
              ))}
              <label className="grid gap-1">
                <span className="text-ui text-muted-foreground">Treasury (receives fees)</span>
                <Input
                  aria-label="Treasury"
                  value={form.treasury}
                  className="font-mono "
                  onChange={(e) => setDraft({ ...form, treasury: e.target.value })}
                />
              </label>
              {typeof proposal === 'string' && (
                <Alert variant="destructive">
                  <AlertDescription>{proposal}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={busy || proposal === null || typeof proposal === 'string'}>
                Review the proposal
              </Button>
            </form>
          )}
        </div>
      )}
    </Section>
  )
}

/** When a timelocked proposal can be executed, and when it lapses (the contract's `PROPOSAL_GRACE()` after its eta). */
function Expiry({ eta, now, grace, verb }: { eta: number; now: number; grace: number | undefined; verb: string }) {
  if (grace === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        {now < eta ? (
          <>
            {verb} in <Countdown to={eta} /> · <When at={eta} show="time" />.
          </>
        ) : (
          'When it lapses cannot be read right now.'
        )}
      </p>
    )
  const state = proposalState(eta, now, Number(grace))
  const lapses = eta + Number(grace)
  return (
    <p className="text-sm text-muted-foreground">
      {state === 'waiting' ? (
        <>
          {verb} in <Countdown to={eta} /> · <When at={eta} show="time" />. Expires at <When at={lapses} show="time" />.
        </>
      ) : state === 'open' ? (
        <>
          {verb} now, by anyone, until <When at={lapses} show="time" /> (<Countdown to={lapses} /> left).
        </>
      ) : (
        <span className="text-warning-text">
          Expired at <When at={lapses} show="time" />: the contract refuses it now. Cancel it, or propose again.
        </span>
      )}
    </p>
  )
}

function ScheduleTable({ title, schedule }: { title: string; schedule: Schedule }) {
  return (
    <div className="grid gap-1">
      <p className="px-1 text-ui text-muted-foreground">{title}</p>
      <ItemGroup>
        {schedule.thresholds.map((t, i) => (
          <Item key={i}>
            <ItemContent className="tabular-nums flex-1">{i === 0 ? 'Any stake' : `From ${fmt(t)}`}</ItemContent>
            <span className="tabular-nums">{percent(schedule.bps[i] ?? 0)}</span>
          </Item>
        ))}
        <Item>
          <ItemContent className="flex-1 text-muted-foreground">Treasury</ItemContent>
          <AddressText value={schedule.treasury} />
        </Item>
      </ItemGroup>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// StakeVault Holdings: the Safe proposes, anyone accepts after the chain's delay, the Safe
// revokes instantly.
// ---------------------------------------------------------------------------------------------------------------

function Holdings({ c, act, busy }: { c: SidequestContracts; act: Act; busy: boolean }) {
  const now = useNow()
  const reads = useReadContracts({
    contracts: [
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'bootstrapped', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'pendingHolding', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'HOLDING_DELAY', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'isHolding', args: [c.holding], chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'PROPOSAL_GRACE', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const bootstrapped = result<boolean>(reads.data, 0)
  const pendingRead = result<readonly [Address, number]>(reads.data, 1)
  const delay = result<number>(reads.data, 2)
  const active = result<boolean>(reads.data, 3)
  const vaultGrace = result<number>(reads.data, 4)
  const pending =
    pendingRead !== undefined && !same(pendingRead[0], zeroAddress)
      ? { holding: pendingRead[0], eta: Number(pendingRead[1]) }
      : null
  const [proposed, setProposed] = useState('')
  const [revoked, setRevoked] = useState<string>(c.holding)
  const vault = (call: Omit<Call, 'contract' | 'to' | 'abi'>): Call => ({
    contract: 'StakeVault',
    to: c.vault,
    abi: sdk.stakeVaultAbi,
    ...call,
  })
  const timing =
    delay === undefined
      ? 'The Holding admission delay cannot be read from the chain right now.'
      : `A proposed Holding can be accepted ${duration(Number(delay))} after it is proposed, so every staker can leave or refuse it first.`
  const valid = (a: string) => isAddress(a.trim(), { strict: false }) && !same(a.trim(), zeroAddress)

  return (
    <Section title="Stake vault Holdings" note={`Only an authorized Holding can reserve bonds from stake. ${timing}`}>
      {reads.isError ? (
        <Unavailable retry={() => void reads.refetch()} />
      ) : bootstrapped === undefined ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="grid gap-3">
          <ItemGroup>
            <Item>
              <ItemContent className="min-w-0 flex-1">
                v1 Holding
                <ItemDescription className="block text-xs text-muted-foreground">
                  <AddressText value={c.holding} />
                </ItemDescription>
              </ItemContent>
              {active === true ? (
                <Badge variant="success">Authorized</Badge>
              ) : (
                <Badge variant="warning">Not authorized</Badge>
              )}
            </Item>
            <Item>
              <ItemContent className="flex-1">Staking</ItemContent>
              {bootstrapped ? (
                <Badge variant="success">Open</Badge>
              ) : (
                <Badge variant="warning">Closed until a first Holding</Badge>
              )}
            </Item>
          </ItemGroup>
          {pending !== null && (
            <div className="grid gap-2 rounded-xl bg-primary/10 px-4 py-3.5">
              <p className="text-sm">
                Proposed Holding <AddressText value={pending.holding} />
              </p>
              <Expiry eta={pending.eta} now={now} grace={vaultGrace} verb="Acceptable" />
              <div className="flex flex-wrap gap-2">
                <Button
                  className="flex-1"
                  disabled={
                    busy || vaultGrace === undefined || proposalState(pending.eta, now, Number(vaultGrace)) !== 'open'
                  }
                  onClick={() => act('Accept the proposed Holding', vault({ functionName: 'acceptHolding' }), 'direct')}
                >
                  Accept
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={busy}
                  onClick={() =>
                    act('Cancel the Holding proposal', vault({ functionName: 'cancelHoldingProposal' }), 'safe')
                  }
                >
                  Cancel proposal
                </Button>
              </div>
            </div>
          )}
          <form
            className="grid gap-2 rounded-xl bg-card px-4 py-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid(proposed))
                act('Propose a Holding', vault({ functionName: 'proposeHolding', args: [proposed.trim()] }), 'safe')
            }}
          >
            <label className="grid gap-1">
              <span className="text-ui font-semibold">Propose a Holding</span>
              <Input
                aria-label="Holding to propose"
                value={proposed}
                placeholder="0x… Holding contract"
                className="font-mono "
                onChange={(e) => setProposed(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy || !valid(proposed)}>
              Review the proposal
            </Button>
          </form>
          <form
            className="grid gap-2 rounded-xl bg-card px-4 py-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid(revoked))
                act('Revoke a Holding', vault({ functionName: 'revokeHolding', args: [revoked.trim()] }), 'safe')
            }}
          >
            <label className="grid gap-1">
              <span className="text-ui font-semibold">Revoke a Holding</span>
              <span className="text-ui text-muted-foreground">
                Instant. It can no longer reserve bonds; its live jobs still release and slash what they reserved.
              </span>
              <Input
                aria-label="Holding to revoke"
                value={revoked}
                className="font-mono "
                onChange={(e) => setRevoked(e.target.value)}
              />
            </label>
            <Button type="submit" variant="destructive" disabled={busy || !valid(revoked)}>
              Review the revocation
            </Button>
          </form>
        </div>
      )}
    </Section>
  )
}
