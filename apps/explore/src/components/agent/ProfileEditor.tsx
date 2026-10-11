import * as sdk from '@sidequest/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { Button } from '../ui/button.tsx'
import { Input } from '../ui/input.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { Label } from '../ui/label.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { useAuth } from '../Wallet.tsx'
import { AgentOrb } from './AgentOrb.tsx'
import {
  AVATAR_TYPES,
  generateAvatar,
  hostedRegistrationUrl,
  saveProfile,
  uploadAvatar,
  type ProfileFields,
  type SavedProfile,
} from '../../agent-profile-api.ts'
import { chain, deployment } from '../../wallet.ts'

const LIMITS = { name: 80, tagline: 120, description: 600 } as const

/** Reloads every view of the agent's profile after a write: orbs, headers, lists and the owner's agent list. */
function useRefresh() {
  const queries = useQueryClient()
  return () => {
    void queries.invalidateQueries({ queryKey: ['data-profiles'] })
    void queries.invalidateQueries({ queryKey: ['managed-agents'] })
  }
}

function errorText(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback
}

/** The avatar: generated from a short description of the agent, or a picture from the owner's device. */
function AvatarControls({ agentId, managedId, subject }: { agentId: string; managedId: string; subject: string }) {
  const refresh = useRefresh()
  const file = useRef<HTMLInputElement>(null)
  const [prompt, setPrompt] = useState(subject)
  const [busy, setBusy] = useState<'generate' | 'upload' | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function run(kind: 'generate' | 'upload', write: () => Promise<SavedProfile>) {
    setBusy(kind)
    setError(null)
    try {
      await write()
      refresh()
    } catch (failure) {
      setError(errorText(failure, 'The avatar could not be saved'))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-4">
        <AgentOrb agentId={agentId} size="lg" />
        <div className="grid min-w-0 flex-1 gap-2">
          <Input
            value={prompt}
            maxLength={600}
            onChange={(event) => setPrompt(event.target.value)}
            aria-label="What the avatar should show"
            placeholder="A friendly robot holding a film camera"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              busy={busy === 'generate'}
              disabled={busy !== null || prompt.trim() === ''}
              onClick={() => void run('generate', () => generateAvatar(managedId, prompt.trim()))}
            >
              Generate
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => file.current?.click()}>
              Upload a picture
            </Button>
            <input
              ref={file}
              type="file"
              accept={AVATAR_TYPES.join(',')}
              className="hidden"
              onChange={(event) => {
                const chosen = event.target.files?.[0]
                event.target.value = ''
                if (chosen !== undefined) void run('upload', () => uploadAvatar(managedId, chosen))
              }}
            />
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Generated pictures take a few seconds; ten a day. Uploads: PNG, JPEG or WebP, up to 1 MB.
      </p>
      {error !== null && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}

/** Points the agent's ERC-8004 record at its hosted registration file, once; later edits need no transaction. */
function PublishIdentity({
  agentId,
  managedId,
  current,
}: {
  agentId: string
  managedId: string
  current: string | undefined
}) {
  const auth = useAuth()
  const [sending, setSending] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const url = hostedRegistrationUrl(window.location.origin, managedId)
  if (done || current === url) return null
  const data = encodeFunctionData({ abi: sdk.identityAbi, functionName: 'setAgentURI', args: [BigInt(agentId), url] })
  return (
    <div className="grid gap-2 rounded-xl bg-muted/50 p-4">
      <p className="text-sm font-medium">Publish this profile to ERC-8004</p>
      <p className="text-sm text-muted-foreground">
        The agent's on-chain record still names its old profile. Point it at the hosted one with one transaction; every
        edit after that shows up everywhere without another.
      </p>
      {sending === null ? (
        <Button size="sm" className="justify-self-start" onClick={() => setSending(`publish:${agentId}:${Date.now()}`)}>
          Publish on-chain
        </Button>
      ) : (
        <TxSteps
          taskId={sending}
          txs={[
            {
              description: 'Point the agent ID at its hosted profile',
              chainId: chain.id,
              to: deployment.identity,
              data,
              value: '0',
            },
          ]}
          owner={auth.address}
          reportToBoard={false}
          autoStart
          onDone={() => setDone(true)}
        />
      )}
    </div>
  )
}

/** The owner's editor: avatar, name, tagline and description, saved to the hosted profile. */
export function ProfileEditor({
  agentId,
  managedId,
  initial,
  tokenUri,
  onClose,
}: {
  agentId: string
  managedId: string
  initial: ProfileFields
  tokenUri: string | undefined
  onClose: () => void
}) {
  const refresh = useRefresh()
  const [fields, setFields] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof ProfileFields) => (event: { target: { value: string } }) =>
    setFields((now) => ({ ...now, [key]: event.target.value }))
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await saveProfile(managedId, { ...fields, name: fields.name.trim() })
      refresh()
      onClose()
    } catch (failure) {
      setError(errorText(failure, 'The profile could not be saved'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-5 rounded-2xl border border-border bg-card p-4 sm:p-5" aria-label="Edit profile">
      <AvatarControls agentId={agentId} managedId={managedId} subject={[fields.name, fields.tagline].join(', ')} />
      <div className="grid gap-1.5">
        <Label htmlFor="profile-name">Name</Label>
        <Input id="profile-name" value={fields.name} maxLength={LIMITS.name} onChange={set('name')} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="profile-tagline">Tagline</Label>
        <Input
          id="profile-tagline"
          value={fields.tagline}
          maxLength={LIMITS.tagline}
          onChange={set('tagline')}
          placeholder="Explainers, documentaries and podcasts"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="profile-description">Description</Label>
        <Textarea
          id="profile-description"
          value={fields.description}
          maxLength={LIMITS.description}
          rows={4}
          onChange={set('description')}
        />
      </div>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button busy={busy} disabled={fields.name.trim() === ''} onClick={() => void save()}>
          Save profile
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <PublishIdentity agentId={agentId} managedId={managedId} current={tokenUri} />
    </section>
  )
}
