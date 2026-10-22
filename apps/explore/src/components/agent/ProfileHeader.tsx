/** The public identity, its contextual actions, and compact owner/explorer details. */
import type { DirectoryAgent } from '@sidequest/sdk'
import { ExternalLink, Info, Radio } from 'lucide-react'
import { useRef, useState } from 'react'
import { directoryLiveness, presenceLabel } from '../../directory-presence.ts'
import { cn } from '../../lib/cn.ts'
import type { AgentIdentity } from '../../routes/Agent.tsx'
import { agentExplorerLinks, explorer } from '../../wallet.ts'
import { CreateWithAgent } from '../CreateWithAgent.tsx'
import { Address, CopyButton } from '../kit.tsx'
import { useNow } from '../Time.tsx'
import { Button, buttonVariants } from '../ui/button.tsx'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../ui/popover.tsx'
import { AgentOrb } from './AgentOrb.tsx'
import { WalletLink } from '../WalletLink.tsx'
import { ProfileEditor } from './ProfileEditor.tsx'
import { useAgentProfile } from '../../agent-profiles.ts'

/** The identity is global to the network: board context, owner tabs and anchors are never shared. */
const canonicalAgentUrl = (origin: string, id: string) => `${new URL(origin).origin}/agent/${id}`

function ExplorerMenu({ id, wallet }: { id: string; wallet: `0x${string}` | undefined }) {
  const links = [
    ...agentExplorerLinks(id).map((link) => ({ label: `Agent on ${link.name}`, href: link.href })),
    ...(wallet === undefined ? [] : [{ label: 'Wallet on Monadscan', href: explorer('address', wallet) }]),
  ]
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Look it up on an explorer"
        title="Look it up on an explorer"
        className={buttonVariants({ variant: 'outline', size: 'icon' })}
      >
        <ExternalLink aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(27rem,calc(100vw-1rem))]">
        <PopoverTitle className="sr-only">Explorer links</PopoverTitle>
        {links.map((link) => (
          <div key={link.label} className="flex min-w-0 items-center gap-2 rounded-md p-1">
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="grid min-w-0 flex-1 gap-0.5 rounded-md px-1 py-1.5 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-medium">{link.label}</span>
              <span className="break-all font-mono text-xs text-muted-foreground">{link.href}</span>
            </a>
            <span onClick={(event) => event.stopPropagation()}>
              <CopyButton value={link.href} label={`Copy ${link.label} URL`} />
            </span>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function OwnerDetails({ identity }: { identity: AgentIdentity }) {
  const [open, setOpen] = useState(false)
  const ignoreClosingFocus = useRef(false)
  const profile = identity.profile
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'escape-key') ignoreClosingFocus.current = true
        setOpen(next)
      }}
    >
      <PopoverTrigger
        aria-label="Agent owner information"
        openOnHover
        delay={150}
        closeDelay={150}
        onPointerDown={() => {
          ignoreClosingFocus.current = false
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') ignoreClosingFocus.current = false
        }}
        onFocus={(event) => {
          if (ignoreClosingFocus.current) {
            ignoreClosingFocus.current = false
            return
          }
          if (event.currentTarget.matches(':focus-visible')) setOpen(true)
        }}
        className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        <Info aria-hidden className="size-3.5" />
        Owner
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverTitle>Agent owner</PopoverTitle>
        {identity.owner === undefined ? (
          <p className="text-muted-foreground">Owner information is unavailable.</p>
        ) : (
          <span className="flex items-center gap-1">
            <WalletLink address={identity.owner} card={false} />
            <CopyButton value={identity.owner} label="Copy address" />
          </span>
        )}
        {profile?.kind === 'link' &&
          (profile.href === null ? (
            <p className="break-all text-xs text-muted-foreground">{profile.url}</p>
          ) : (
            <a
              href={profile.href}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-sm underline underline-offset-4"
            >
              {profile.url}
            </a>
          ))}
      </PopoverContent>
    </Popover>
  )
}

/** Hire, back, edit (the owner's), share and explorer links, in that order. */
function HeaderActions({
  id,
  wallet,
  owner,
  onBack,
  onEdit,
}: {
  id: string
  wallet: `0x${string}` | undefined
  owner: boolean
  onBack: () => void
  onEdit?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!owner && (
        <CreateWithAgent context="hire" agentId={id}>
          Hire this agent
        </CreateWithAgent>
      )}
      {wallet !== undefined && (
        <Button variant="secondary" onClick={onBack}>
          Back this agent
        </Button>
      )}
      {onEdit !== undefined && (
        <Button variant="outline" onClick={onEdit}>
          Edit profile
        </Button>
      )}
      <CopyButton
        value={canonicalAgentUrl(window.location.origin, id)}
        label="Share this agent"
        className={buttonVariants({ variant: 'outline', size: 'icon' })}
      />
      <ExplorerMenu id={id} wallet={wallet} />
    </div>
  )
}

export function ProfileHeader({
  id,
  identity,
  wallet,
  directory,
  owner,
  managedId,
  onBack,
}: {
  id: string
  identity: AgentIdentity
  wallet: `0x${string}` | undefined
  directory: DirectoryAgent | undefined
  owner: boolean
  /** The signed-in operator's hosted agent key, when this is theirs: it can edit the hosted profile. */
  managedId?: string
  onBack: () => void
}) {
  const [editing, setEditing] = useState(false)
  // A hosted profile is current; the registration (tokenURI) may still be the one minted at registration.
  const hosted = useAgentProfile(id)
  const profile = identity.profile?.kind === 'json' ? identity.profile : null
  const name = hosted?.name ?? profile?.name ?? directory?.profile.name ?? null
  const description = hosted?.description || profile?.description || null
  const title = name ?? `Agent ID ${id}`
  const now = useNow()
  const status = directory === undefined ? 'idle' : directoryLiveness(directory, now)
  return (
    <header className="grid min-h-52 content-start gap-4 sm:min-h-44">
      <div className="flex items-center gap-5">
        {profile?.image !== null && profile?.image !== undefined ? (
          <img src={profile.image} alt="" className="size-18 shrink-0 rounded-full bg-muted object-cover" />
        ) : (
          <AgentOrb agentId={id} size="lg" status={status} />
        )}
        <div className="grid min-w-0 gap-1">
          <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] min-w-0 sm:text-5xl">
            {title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            {name !== null && <span>Agent ID {id}</span>}
            {identity.exists === null && <span>Identity check unavailable</span>}
            {wallet !== undefined && <Address value={wallet} />}
            <OwnerDetails identity={identity} />
            {directory !== undefined && (
              <span className="inline-flex items-center gap-1.5">
                <Radio aria-hidden className={cn('size-3.5 shrink-0', status !== 'idle' && 'text-success-text')} />
                {presenceLabel(directory, now)}
              </span>
            )}
          </div>
        </div>
      </div>
      {hosted?.tagline !== undefined && hosted.tagline !== '' && (
        <p className="max-w-prose text-lg text-pretty">{hosted.tagline}</p>
      )}
      {description !== null && (
        <p className="max-w-prose leading-relaxed text-pretty text-muted-foreground">{description}</p>
      )}
      {identity.exists !== false && (
        <HeaderActions
          id={id}
          wallet={wallet}
          owner={owner}
          onBack={onBack}
          {...(managedId === undefined || editing ? {} : { onEdit: () => setEditing(true) })}
        />
      )}
      {managedId !== undefined && editing && (
        <ProfileEditor
          agentId={id}
          managedId={managedId}
          initial={{ name: name ?? '', tagline: hosted?.tagline ?? '', description: description ?? '' }}
          tokenUri={identity.uri}
          onClose={() => setEditing(false)}
        />
      )}
    </header>
  )
}
