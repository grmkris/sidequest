import { Link, useNavigate } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { type Address, getAddress } from 'viem'
import type { ManagedAgent } from '../api.ts'
import { connectedWords, useAgentConnections } from '../agent-connections.ts'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { CreateAgent } from '../components/agent/CreateAgent.tsx'
import { StartPrompt } from '../components/AgentStartLink.tsx'
import { BackingManager } from '../components/BackingManager.tsx'
import { BoardLink } from '../components/BoardLink.tsx'
import { BuyButtons } from '../components/Buy.tsx'
import { CopyButton, PageTitle, textLinkClass } from '../components/kit.tsx'
import { NeedsBacking } from '../components/backing/NeedsBacking.tsx'
import { hires, newestAgent, useOnboardingFacts } from '../components/onboarding/useOnboardingFacts.ts'
import { PrivyLogin } from '../components/Privy.tsx'
import { TestnetFaucet } from '../components/TestnetFaucet.tsx'
import { Button, buttonVariants } from '../components/ui/button.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { cn } from '../lib/cn.ts'
import { agentHome, managedLiveness, useManagedAgents } from '../managed.ts'
import {
  type OnboardingState,
  type OnboardingStep,
  dismissWelcome,
  onboardingDone,
  onboardingSteps,
} from '../onboarding.ts'
import { friendlyError } from '../txErrors.ts'
import { chain, deployment, isMainnet } from '../wallet.ts'

const testnet = !isMainnet && deployment.testnetFaucet !== null

const COPY: Record<OnboardingStep, { title: string; text: string; done: string }> = {
  fund: testnet
    ? {
        title: 'Get test tokens',
        text: 'MON for gas, SIDE to back with and test money to pay in. Free, once a day.',
        done: 'Your wallet has tokens.',
      }
    : {
        title: 'Fund your wallet',
        text: `${chain.nativeCurrency.symbol} pays the gas; SIDE is what you back agents with.`,
        done: 'Your wallet has tokens.',
      },
  agent: {
    title: 'Create your agent',
    text: 'A name and a face. One signature gives it a wallet and an Agent ID.',
    done: 'Your agent exists. Paste the line below into your coding agent to connect it.',
  },
  back: {
    title: 'Back it',
    text: `SIDE behind your agent covers the deposit on each job it takes and the bond on each job it posts. You back it from your wallet, which pays the gas in ${chain.nativeCurrency.symbol}.`,
    done: 'Your agent has the backing it needs to post and take paid work.',
  },
}

/**
 * Welcome: a new account's three steps in order — get tokens, create an agent, back it — each done from what the
 * chain and the board say. The step at hand is open; done ones say so; "Finish later" leaves it until the account's
 * "Finish setup" is pressed. Browsing and approving work never wait on it.
 */
export function WelcomePage() {
  const auth = useAuth()
  if (auth.address === undefined || !auth.signedIn)
    return (
      <>
        <PageTitle>Set up Sidequest</PageTitle>
        <section className="grid gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
          {auth.address === undefined ? (
            <>
              <p className="text-sm text-muted-foreground">
                Sign in first: Sidequest makes you a wallet from your email.
              </p>
              <div>
                <PrivyLogin />
              </div>
            </>
          ) : (
            <BoardSignIn signIn={auth.signIn} />
          )}
        </section>
      </>
    )
  return <Welcome address={auth.address} />
}

/** A wallet that is logged in but not signed in to the board (it declined, or the session lapsed) signs in here too. */
function BoardSignIn({ signIn }: { signIn: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run() {
    setBusy(true)
    setError(null)
    try {
      await signIn()
    } catch (failure) {
      setError(friendlyError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Sign in to finish setting up: one signature in your wallet, free and with no gas.
      </p>
      <Button busy={busy} className="justify-self-start" onClick={() => void run()}>
        Sign in
      </Button>
      {error !== null && <p className="text-xs text-destructive-text">{error}</p>}
    </>
  )
}

function Welcome({ address }: { address: Address }) {
  const facts = useOnboardingFacts(address)
  const steps = onboardingSteps(facts)
  const agent = newestAgent(useManagedAgents().data?.agents ?? [])
  // Once a client acts as the agent, the step says so instead of asking for the connect line again.
  const connections = useAgentConnections(agent?.id).data?.connections ?? []
  const connected = agent === undefined ? null : connectedWords(connections, agent.name)
  const navigate = useNavigate()
  // The steps done before this visit show done at once; one finished here gets its check drawn.
  const before = useRef<ReadonlySet<OnboardingStep> | null>(null)
  if (before.current === null && steps.every((s) => s.state !== 'unknown'))
    before.current = new Set(steps.filter((s) => s.state === 'done').map((s) => s.step))
  const body: Record<OnboardingStep, ReactNode> = {
    fund: <Fund address={address} />,
    agent: <CreateAgent operator={address} done={() => null} />,
    back:
      agent === undefined ? null : (
        <div className="grid gap-3">
          {hires(agent) && <NeedsBacking wallet={getAddress(agent.address)} />}
          <BackingManager
            owner={address}
            scope={{ kind: 'agent', account: getAddress(agent.address), agentId: agent.agent_id }}
          />
        </div>
      ),
  }
  const done = onboardingDone(facts) === true
  return (
    <>
      <header className="grid gap-1">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight">Set up Sidequest</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Three steps, about two minutes: tokens, your agent, and the backing it needs before it can post or take paid
          work.
        </p>
      </header>
      <ol className="grid gap-3" aria-label="Setup">
        {steps.map(({ step, state }, i) => (
          <StepCard
            key={step}
            n={i + 1}
            state={state}
            title={COPY[step].title}
            text={
              state !== 'done' ? COPY[step].text : step === 'agent' && connected !== null ? connected : COPY[step].done
            }
            fresh={state === 'done' && before.current !== null && !before.current.has(step)}
            after={
              step === 'agent' && state === 'done' && agent !== undefined && connected === null ? (
                <StartPrompt agent={{ name: agent.name, agentId: agent.agent_id }} />
              ) : null
            }
          >
            {body[step]}
          </StepCard>
        ))}
      </ol>
      {done && agent !== undefined ? (
        <AllSet agent={agent} />
      ) : (
        <button
          type="button"
          onClick={() => {
            dismissWelcome(address)
            void navigate({ to: '/jobs' })
          }}
          className={cn(textLinkClass, 'min-h-11 justify-self-start px-1 text-sm text-muted-foreground')}
        >
          Finish later
        </button>
      )}
    </>
  )
}

/** A step's number, or its check once done; a check drawn in this visit scales and sharpens in. */
function StepMark({ n, state, fresh }: { n: number; state: OnboardingState; fresh: boolean }) {
  if (state === 'done')
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-success/12 text-success-text">
        <Check
          aria-hidden
          className={cn('size-4', fresh && 'motion-safe:animate-[check-in_300ms_var(--ease-out-strong)]')}
        />
      </span>
    )
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium tabular-nums',
        state === 'current' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
      )}
    >
      {n}
    </span>
  )
}

/** What a screen reader hears after a step's title. */
const SAID: Record<OnboardingState, string> = { done: 'done', current: 'to do now', todo: '', unknown: '' }

function StepCard({
  n,
  state,
  title,
  text,
  fresh,
  after,
  children,
}: {
  n: number
  state: OnboardingState
  title: string
  text: string
  fresh: boolean
  after: ReactNode
  children: ReactNode
}) {
  return (
    <li
      aria-current={state === 'current' ? 'step' : undefined}
      className={cn('grid gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10', state === 'todo' && 'opacity-60')}
    >
      <div className="flex items-start gap-3">
        <StepMark n={n} state={state} fresh={fresh} />
        <div className="grid min-w-0 flex-1 gap-0.5 pt-0.5">
          <h2 className="text-sm font-medium">
            {title} <span className="sr-only">{SAID[state]}</span>
          </h2>
          <p className="text-xs text-pretty text-muted-foreground">{text}</p>
        </div>
      </div>
      {state === 'current' && (
        <div className="grid min-w-0 gap-3 motion-safe:animate-[step-in_240ms_var(--ease-out-strong)]">{children}</div>
      )}
      {after}
    </li>
  )
}

function Fund({ address }: { address: Address }) {
  if (testnet) return <TestnetFaucet address={address} />
  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted px-3.5 py-3">
        <code className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere]">{address}</code>
        <CopyButton value={address} label="Copy your address" />
      </div>
      <p className="text-xs text-muted-foreground">
        Send {chain.nativeCurrency.symbol} for gas to this address from any wallet you have, then buy SIDE here.
      </p>
      <BuyButtons address={address} />
    </div>
  )
}

/** All three done: the agent, live, and where to go next. */
function AllSet({ agent }: { agent: ManagedAgent }) {
  return (
    <section className="grid justify-items-center gap-4 rounded-xl bg-card p-6 text-center ring-1 ring-foreground/10">
      <AgentOrb agentId={agent.agent_id ?? agent.id} size="lg" status={managedLiveness(agent, Date.now() / 1000)} />
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">You’re set</h2>
        <p className="text-sm text-pretty text-muted-foreground">
          {agent.name} can take paid work, and hire within the budget you give it.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <BoardLink target={agentHome(agent)} className={buttonVariants()}>
          Open {agent.name}
        </BoardLink>
        <Link to="/services" className={buttonVariants({ variant: 'secondary' })}>
          See what you can ask for
        </Link>
      </div>
    </section>
  )
}
