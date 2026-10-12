import { usePrivy } from '@privy-io/react-auth'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Circle } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type Address, zeroAddress } from 'viem'
import { prompts, useSignTypedDataWithPrompt } from '../../wallet-prompt.ts'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { Button } from '../ui/button.tsx'
import { Input } from '../ui/input.tsx'
import { Label } from '../ui/label.tsx'
import { Spinner } from '../ui/spinner.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { useDelegatorUpgrade } from '../Privy.tsx'
import { AgentOrb } from './AgentOrb.tsx'
import { agentEndpoint, type ManagedAgent } from '../../api.ts'
import { agentAction, prepareRegistration } from '../../agent-api.ts'
import { reviewAgentGrant } from '../../agent-grant.ts'
import { generateAvatar, saveProfile } from '../../agent-profile-api.ts'
import {
  registrationBatch,
  registrationRecord,
  registrationSteps,
  type RegistrationBatch,
} from '../../agent-registration-api.ts'
import { typedDataArgs } from '../../typed-data.ts'
import { chain, deployment, wagmiConfig } from '../../wallet.ts'

/** Whether this network's board relays registrations; without a relay the operator's wallet pays its own gas. */
const relayed = deployment.relay.toLowerCase() !== zeroAddress

type Stage = 'wallet' | 'profile' | 'identity'
const STAGES: Stage[] = ['wallet', 'profile', 'identity']
const LABEL: Record<Stage, [doing: string, done: string]> = {
  wallet: ['Creating its own wallet', 'Its own wallet is ready'],
  profile: ['Saving its profile and avatar', 'Profile saved'],
  identity: ['Registering its Agent ID to you', 'Agent ID registered'],
}

const errorText = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback)

/** The draft's key survives a reload, so a retried create resumes the same agent instead of making a second one. */
function useDraft(operator: Address, initial: ManagedAgent | undefined) {
  const key = `sidequest.agent-draft:${operator}`
  const [draft] = useState<{ id: string; name: string }>(() => {
    if (initial !== undefined) return { id: initial.id, name: initial.name }
    try {
      const saved: { id?: string; name?: string } | null = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (saved?.id !== undefined) return { id: saved.id, name: saved.name ?? '' }
    } catch {
      // This tab keeps the same intent without storage.
    }
    return { id: crypto.randomUUID(), name: '' }
  })
  const save = (name: string) => {
    try {
      localStorage.setItem(key, JSON.stringify({ id: draft.id, name }))
    } catch {
      // The in-memory draft still survives retries.
    }
  }
  const clear = () => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Setup is already durably stored.
    }
  }
  return { id: draft.id, name: draft.name, save, clear }
}

/** Creation runs wallet, then profile, then hands the identity stage to the page (it needs the person's wallet). */
function useCreation(operator: Address, initial: ManagedAgent | undefined) {
  const { getAccessToken } = usePrivy()
  const queries = useQueryClient()
  const draft = useDraft(operator, initial)
  const [agent, setAgent] = useState(initial)
  const [stage, setStage] = useState<Stage | 'done' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => void queries.invalidateQueries({ queryKey: ['managed-agents', operator] })
  async function wallet(name: string): Promise<ManagedAgent> {
    draft.save(name)
    const token = await getAccessToken()
    let current =
      agent ?? (await agentEndpoint<ManagedAgent>('/api/agents', 'POST', { id: draft.id, name }, token ?? undefined))
    for (let tries = 0; ['created', 'upgraded'].includes(current.state) && tries < 3; tries++)
      current = await agentAction<ManagedAgent>(current.id, 'resume')
    setAgent(current)
    refresh()
    return current
  }
  async function profile(id: string, tagline: string, avatar: string | null) {
    if (tagline !== '') await saveProfile(id, { tagline })
    if (avatar === null) return
    // A missing avatar never blocks the agent; the owner can add one later from Edit profile.
    await generateAvatar(id, avatar).catch((failure: unknown) =>
      setNote(`No avatar yet (${errorText(failure, 'generation failed')}); add one later from Edit profile.`),
    )
  }
  async function start(fields: { name: string; tagline: string; avatar: string | null }) {
    setError(null)
    try {
      setStage('wallet')
      const current = await wallet(fields.name)
      if (current.state === 'active') return finish(current)
      setStage('profile')
      await profile(current.id, fields.tagline, fields.avatar)
      setStage('identity')
    } catch (failure) {
      setError(errorText(failure, 'Setup stopped; retry to continue where it left off'))
    }
  }
  function finish(done: ManagedAgent) {
    setAgent(done)
    setStage('done')
    draft.clear()
    refresh()
    void queries.invalidateQueries({ queryKey: ['data-profiles'] })
  }
  return { draft, agent, stage, note, error, setError, start, finish }
}

/**
 * Where the board runs a relay: one signature on a single-use registration grant, and the relay pays and sends, so
 * no MON is needed. A grant needs the upgraded wallet; an upgrade not yet made is relayed first (one more signature).
 */
function SponsoredRegistration({ agent, operator, onDone, onError }: IdentityProps) {
  const signTypedData = useSignTypedDataWithPrompt()
  const upgrade = useDelegatorUpgrade(operator)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const upgraded = upgrade === null ? null : await upgrade()
      if (upgraded !== null) await waitForTransactionReceipt(wagmiConfig, { hash: upgraded, chainId: chain.id })
      const review = reviewAgentGrant(await prepareRegistration(agent.id), {
        kind: 'registration',
        delegator: operator,
      })
      const signature = await signTypedData(typedDataArgs(review.typedData), prompts.registration(agent.name))
      const result = await agentAction<ManagedAgent | { status: string }>(agent.id, 'registration-confirm', {
        hash: review.hash,
        signature,
      })
      if (!('state' in result)) throw new Error(`Registration is ${result.status}; retry to reconcile it`)
      onDone(result)
    })().catch(onError)
  }, [agent.id, operator, onDone, onError, signTypedData, upgrade])
  return <p className="text-sm text-muted-foreground">Sign once in your wallet; Sidequest pays the gas.</p>
}

/** Without a relay (a network that sponsors nothing): the upgraded wallet sends both calls as one transaction. */
function SelfPaidRegistration({ agent, operator, onDone, onError }: IdentityProps) {
  const upgrade = useDelegatorUpgrade(operator)
  const started = useRef(false)
  const [batch, setBatch] = useState<RegistrationBatch | null>(null)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const upgraded = upgrade === null ? null : await upgrade()
      if (upgraded !== null) await waitForTransactionReceipt(wagmiConfig, { hash: upgraded, chainId: chain.id })
      setBatch(await registrationBatch(agent.id))
    })().catch(onError)
  }, [agent.id, onError, upgrade])
  if (batch === null) return <p className="text-sm text-muted-foreground">Preparing the registration…</p>
  return (
    <TxSteps
      taskId={`register:${agent.id}:${batch.predictedAgentId}`}
      txs={registrationSteps(batch)}
      owner={operator}
      reportToBoard={false}
      allowSponsorship={false}
      autoStart
      onDone={(hashes) => {
        const hash = hashes.at(-1)
        if (hash === undefined) return onError(new Error('The registration was not sent'))
        void registrationRecord(agent.id, hash).then(onDone, onError)
      }}
    />
  )
}

interface IdentityProps {
  agent: ManagedAgent
  operator: Address
  onDone: (agent: ManagedAgent) => void
  onError: (failure: unknown) => void
}

function IdentityStep(props: IdentityProps) {
  return relayed ? <SponsoredRegistration {...props} /> : <SelfPaidRegistration {...props} />
}

function ProgressRow({ stage, current, children }: { stage: Stage; current: Stage; children?: ReactNode }) {
  const order = STAGES.indexOf(stage) - STAGES.indexOf(current)
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-3">
      {order < 0 ? (
        <Check aria-label="Done" className="mt-0.5 size-4 text-success-text" />
      ) : order === 0 ? (
        <Spinner className="mt-0.5 size-4" />
      ) : (
        <Circle aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      )}
      <div className="grid gap-2">
        <span className={order > 0 ? 'text-muted-foreground' : ''}>{LABEL[stage][order < 0 ? 1 : 0]}</span>
        {order === 0 && children}
      </div>
    </li>
  )
}

/** The form: a name, one line on what it does, and whether to draw it an avatar from those. */
function CreateForm({
  seed,
  initialName,
  onStart,
}: {
  seed: string
  initialName: string
  onStart: (fields: { name: string; tagline: string; avatar: string | null }) => void
}) {
  const [name, setName] = useState(initialName)
  const [tagline, setTagline] = useState('')
  const [avatar, setAvatar] = useState(true)
  const subject = [name.trim(), tagline.trim()].filter(Boolean).join(', ')
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        onStart({ name: name.trim() || 'My agent', tagline: tagline.trim(), avatar: avatar ? subject || null : null })
      }}
    >
      <div className="flex items-center gap-4">
        <AgentOrb agentId={seed} size="lg" />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            value={name}
            maxLength={80}
            placeholder="Reel"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="agent-tagline">What it does</Label>
        <Input
          id="agent-tagline"
          value={tagline}
          maxLength={120}
          placeholder="Explainer videos with voiceover"
          onChange={(e) => setTagline(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={avatar} onChange={(e) => setAvatar(e.target.checked)} className="size-4" />
        Draw it an avatar from its name and what it does
      </label>
      <Button type="submit" size="lg">
        Create agent
      </Button>
      <p className="text-ui text-muted-foreground">
        It gets its own wallet; its Agent ID is registered to yours, with one confirmation in your wallet.
      </p>
    </form>
  )
}

/**
 * Create an agent on one screen: name and purpose, then one button runs its wallet, its profile and its identity.
 * `done` renders what follows (the pairing prompt, or the OAuth connection's choice).
 */
export function CreateAgent({
  operator,
  initial,
  startLabel,
  done,
}: {
  operator: Address
  initial?: ManagedAgent
  /** The resume button's words for an agent that already exists ("Continue setting up …" by default). */
  startLabel?: string
  done: (agent: ManagedAgent) => ReactNode
}) {
  const creation = useCreation(operator, initial)
  const { agent, stage } = creation
  if (stage === 'done' && agent !== undefined) return <>{done(agent)}</>
  const current: Stage = stage === 'done' || stage === null ? 'identity' : stage
  return (
    <div className="grid gap-6">
      {stage === null && initial !== undefined && (
        <Button
          size="lg"
          onClick={() => void creation.start({ name: initial.name, tagline: '', avatar: null })}
          className="justify-self-start"
        >
          {startLabel ?? `Continue setting up ${initial.name}`}
        </Button>
      )}
      {stage === null && initial === undefined ? (
        <CreateForm
          seed={creation.draft.id}
          initialName={creation.draft.name}
          onStart={(f) => void creation.start(f)}
        />
      ) : stage === null ? null : (
        <ol className="grid gap-4" aria-label="Setting up your agent">
          {STAGES.map((row) => (
            <ProgressRow key={row} stage={row} current={current}>
              {row === 'identity' && agent !== undefined && creation.error === null && (
                <IdentityStep
                  agent={agent}
                  operator={operator}
                  onDone={creation.finish}
                  onError={(failure) => creation.setError(errorText(failure, 'Registration did not go through'))}
                />
              )}
            </ProgressRow>
          ))}
        </ol>
      )}
      {creation.note !== null && <p className="text-sm text-muted-foreground">{creation.note}</p>}
      {creation.error !== null && (
        <Alert variant="destructive">
          <AlertDescription className="grid gap-3">
            {creation.error}
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() =>
                void creation.start({ name: agent?.name ?? creation.draft.name, tagline: '', avatar: null })
              }
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
