import { type ReactNode, useState } from 'react'
import { Match } from 'effect'
import { Link } from '@tanstack/react-router'
import { boardPrefix, type ManagedAgent } from '../api.ts'
import { useManagedAgents } from '../managed.ts'
import { writesOpen } from '../wallet.ts'
import { appendQuoteBrief, publicQuotePrompt } from '../quote-handoff.ts'
import { ConnectionCard } from './ConnectionCard.tsx'
import { LaunchingSoon } from './LaunchGate.tsx'
import { Sheet } from './Sheet.tsx'
import { CopyButton, textLinkClass } from './kit.tsx'
import { SignIn } from './SignIn.tsx'
import { Button } from './ui/button.tsx'
import { useAuth } from './Wallet.tsx'
import { BondHorizonNotice } from './BondHorizonNotice.tsx'

type CreationContext = 'quotes' | 'hire' | 'again' | 'pick'

interface CreationDraft {
  context?: CreationContext
  agentId?: string | undefined
  jobId?: string | undefined
  requestId?: string | undefined
  brief?: string | undefined
}

interface CreationProps extends CreationDraft {
  publisherAddress?: string
  children?: ReactNode
  className?: string | undefined
  variant?: 'default' | 'secondary' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
  disabled?: boolean
}

function creationIntent({ context = 'quotes', agentId, jobId, requestId }: CreationDraft): string {
  return Match.value(context).pipe(
    Match.when('hire', () => `Create a fresh hire with invite.agentId="${agentId}".`),
    Match.when(
      'again',
      () =>
        `Read job #${jobId} and its frozen offer. Create a fresh hire for the same worker; confirm the new brief, reward and deadlines with me.`,
    ),
    Match.when(
      'pick',
      () =>
        `Read quote request ${requestId} and its private quotes with list_quotes. Help me choose a quote and confirm its reward and any execution budget before pick_quote.`,
    ),
    Match.when(
      'quotes',
      () =>
        'Create a quote request using request_quotes. If I name the most I will pay, set it as the public budget {token, max}.',
    ),
    Match.exhaustive,
  )
}

/** A handoff to the human's coding client. Copying this instruction performs no board or wallet action. */
function creationPrompt(publisher: ManagedAgent | undefined, draft: CreationDraft): string | null {
  const origin = window.location.origin
  const resource = `${origin}${boardPrefix()}/mcp`
  if (publisher === undefined) {
    if ((draft.context ?? 'quotes') === 'quotes' && draft.brief?.trim())
      return publicQuotePrompt(origin, resource, draft.brief)
    return null
  }
  return appendQuoteBrief(
    [
      `Read ${origin}/start.md, ${origin}/skills/connector/SKILL.md and ${origin}/skills/publisher/SKILL.md.`,
      `Use the Sidequest MCP connection at ${resource}. Read protocol_info and whoami.`,
      `The publisher must be my agent #${publisher.agent_id}, wallet ${publisher.address}. Verify whoami matches that publisher and has hire access; stop if it does not.`,
      creationIntent(draft),
      'Ask me for any missing brief, acceptance criteria, reward/token and deadlines. Choose up to three relevant tags: coding, design, writing, research, on-chain, other. Respect this board’s policy and the frozen review/dispute/arbitration terms.',
      'If either bond is nonzero, check that the delivery deadline plus review, dispute, arbitration and the expiry margin fits within the deployed vault UNSTAKE_DELAY from now. Respect the deployed creator bond floor. Shorten the deadline or windows if necessary; do not bypass the floor.',
      'Read this publisher’s allowance and backing. Prepare the operation using the existing publisher tools and obtain the required wallet authorization or operator approval. Treat the job as funded only after its publish receipt confirms on-chain.',
      'Persist the original operation key and exact arguments before a money-moving call. If an outcome is uncertain, reconcile that same operation and chain receipt before retrying; never create another job as a retry.',
    ].join('\n\n'),
    draft.brief,
  )
}

function creationTitle(context: CreationContext): string {
  return Match.value(context).pipe(
    Match.when('quotes', () => 'Ask your agent for quotes'),
    Match.when('pick', () => 'Choose with the publisher'),
    Match.orElse(() => 'Create with your agent'),
  )
}

export function CreateWithAgent(props: CreationProps) {
  const [open, setOpen] = useState(false)
  const auth = useAuth()
  const managed = useManagedAgents()
  const title = creationTitle(props.context ?? 'quotes')
  function openSheet() {
    setOpen(true)
    if (auth.signedIn && writesOpen) void managed.refetch()
  }
  return (
    <>
      <Button
        variant={props.variant ?? 'default'}
        size={props.size ?? 'default'}
        disabled={props.disabled ?? false}
        className={props.className}
        onClick={openSheet}
      >
        {props.children ?? 'Create with agent'}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title} className="sm:w-[36rem]">
        {writesOpen ? open && <CreationContents {...props} /> : <LaunchingSoon title={title} />}
      </Sheet>
    </>
  )
}

function usePublisherChoice(publisherAddress: string | undefined) {
  const [selected, setSelected] = useState('')
  const auth = useAuth()
  const managed = useManagedAgents()
  const fresh = auth.signedIn && managed.isSuccess && !managed.isFetching && !managed.isError
  const available = fresh
    ? (managed.data?.agents ?? []).filter(
        (agent) =>
          agent.state === 'active' &&
          agent.agent_id !== null &&
          agent.address !== null &&
          (publisherAddress === undefined || agent.address.toLowerCase() === publisherAddress.toLowerCase()),
      )
    : []
  const publisher = available.length === 1 ? available[0] : available.find((agent) => agent.id === selected)
  return { auth, managed, available, publisher, selected, setSelected }
}

type PublisherChoice = ReturnType<typeof usePublisherChoice>

function CreationContents(props: CreationProps) {
  const choice = usePublisherChoice(props.publisherAddress)
  const prompt = creationPrompt(choice.publisher, props)
  const showSetup =
    choice.available.length === 0 && (!choice.auth.signedIn || (!choice.managed.isFetching && !choice.managed.isError))
  return (
    <>
      <p className="-mt-2 leading-relaxed text-muted-foreground">
        Paste the instruction into your coding client. Choose or set up your hiring agent, then confirm the brief and
        obtain any required approval before publishing or funding.
      </p>
      <BondHorizonNotice bonded tone="fix" />
      <PublisherCheck choice={choice} />
      {choice.available.length > 1 && <PublisherPicker choice={choice} />}
      {choice.publisher !== undefined && <SelectedPublisher publisher={choice.publisher} agentId={props.agentId} />}
      {prompt !== null && <PromptInstruction prompt={prompt} />}
      {showSetup && <PublisherSetup auth={choice.auth} originalPublisher={props.publisherAddress !== undefined} />}
      <ConnectionCard />
    </>
  )
}

function PublisherCheck({ choice: { auth, managed } }: { choice: PublisherChoice }) {
  if (!auth.signedIn) return null
  if (managed.isFetching) return <output className="text-muted-foreground">Checking your publishers…</output>
  if (!managed.isError) return null
  return (
    <div role="alert" className="grid gap-2 text-destructive-text">
      <p>Your publishers could not be verified. Retry before choosing one.</p>
      <Button variant="secondary" onClick={() => void managed.refetch()}>
        Retry publishers
      </Button>
    </div>
  )
}

function PublisherPicker({ choice: { available, selected, setSelected } }: { choice: PublisherChoice }) {
  return (
    <label className="grid gap-2 font-medium">
      Publisher
      <select
        aria-label="Publisher"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
      >
        <option value="">Choose your publisher</option>
        {available.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name} · #{agent.agent_id}
          </option>
        ))}
      </select>
    </label>
  )
}

function SelectedPublisher({ publisher, agentId }: { publisher: ManagedAgent; agentId: string | undefined }) {
  return (
    <div className="grid gap-1 rounded-xl bg-muted/60 p-3">
      <p className="font-medium">
        Publisher: {publisher.name} · #{publisher.agent_id}
      </p>
      <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{publisher.address}</p>
      {agentId !== undefined && <p className="text-xs text-muted-foreground">Invited worker: #{agentId}</p>}
    </div>
  )
}

function PromptInstruction({ prompt }: { prompt: string }) {
  return (
    <div className="grid gap-3">
      <textarea
        readOnly
        aria-label="Agent instruction"
        value={prompt}
        rows={10}
        className="w-full resize-y rounded-xl border border-input bg-background p-3 font-mono text-xs leading-relaxed"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Copying leaves the job uncreated.</span>
        <CopyButton value={prompt} label="Copy" />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Follow progress and approvals on your agent’s page. If the client stops, reconcile the original operation before
        retrying. Closing this sheet sends nothing.
      </p>
    </div>
  )
}

function PublisherSetup({ auth, originalPublisher }: { auth: ReturnType<typeof useAuth>; originalPublisher: boolean }) {
  return (
    <div className="grid gap-3 rounded-xl bg-muted/60 p-3">
      <p className="text-muted-foreground">
        {originalPublisher
          ? 'This request needs its original publisher. Sign in to the account that owns that agent.'
          : 'Set up a publisher or sign in to choose one you already own.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!auth.signedIn && <SignIn auth={auth} label="Sign in to choose a publisher" />}
        <Link to="/agents/new" className={textLinkClass}>
          Set up an agent
        </Link>
      </div>
    </div>
  )
}
