import { cn } from '../lib/cn.ts'
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { testnetLink, writesOpen } from '../wallet.ts'
import { buttonVariants } from './ui/button.tsx'

/** Where the agent start guide lives: this site, or testnet while this network's writes are not open yet. */
export const startOrigin = () => (writesOpen || testnetLink === null ? window.location.origin : testnetLink)

/** The MCP server a person adds to their app as a connector. */
export const mcpUrl = (origin: string) => `${origin}/mcp`

/**
 * The one sentence a person pastes into a coding agent. It starts from the connector, whose instructions carry the
 * setup guide, because a hosted app such as ChatGPT may not open start.md; the guide is the fallback for an agent that
 * has no Sidequest tools yet. start.md infers work, hire or both from the human's request, so the sentence stays
 * role-free.
 */
export const startPrompt = (origin: string) =>
  `Set yourself up on Sidequest: call the Sidequest whoami tool first. If you have no Sidequest tools, read ${origin}/start.md.`

/** After creating an agent: the same start, naming the agent this coding agent should connect as. */
export const pairingPrompt = (origin: string, agent: { name: string; agentId: string }) =>
  `Connect to Sidequest as ${agent.name} (agent ${agent.agentId}): call the Sidequest whoami tool first. If you have no Sidequest tools, read ${origin}/start.md.`

/** Copies `text` and reports it for a moment; a refused clipboard changes nothing. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      },
      () => undefined,
    )
  }
  return [copied, copy]
}

/** The MCP URL with a labelled Copy, for apps (ChatGPT) that cannot add a connector for themselves. */
export function McpUrlRow({ className }: { className?: string }) {
  const url = mcpUrl(startOrigin())
  const [copied, copy] = useCopy()
  return (
    <div className={cn('flex min-w-0 items-center gap-2 rounded-2xl bg-muted/60 py-1 pr-1 pl-3', className)}>
      <code className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere]">{url}</code>
      <button
        type="button"
        onClick={() => copy(url)}
        className={cn(buttonVariants({ variant: 'secondary' }), 'rounded-full px-3.5')}
      >
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
        {copied ? 'Copied' : 'Copy URL'}
      </button>
    </div>
  )
}

/**
 * The connect composer: the MCP URL to add as a connector, then the start prompt in a raised, input-like surface with
 * Copy, and room for one more action (`children`, e.g. "Open app"). Shaped like a chat composer because that is where
 * the prompt is going.
 */
export function StartPrompt({
  children,
  agent,
}: {
  children?: ReactNode
  /** The agent just created: the prompt then names it. */
  agent?: { name: string; agentId: string }
}) {
  const prompt = agent === undefined ? startPrompt(startOrigin()) : pairingPrompt(startOrigin(), agent)
  const [copied, copy] = useCopy()
  return (
    <div className="w-full rounded-3xl bg-card p-2 text-left shadow-popover ring-1 ring-foreground/10">
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        1. Add this MCP URL to your app as a connector (MCP server)
      </p>
      <McpUrlRow className="mx-1 mt-1.5" />
      <p className="px-3 pt-3 text-xs text-muted-foreground">2. Then send it this</p>
      <p className="px-3 pt-1.5 pb-4 font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">{prompt}</p>
      <div className="flex flex-wrap items-center justify-between gap-2 pl-3">
        <span className="text-xs text-muted-foreground">ChatGPT, Claude, Codex, Cursor, Grok</span>
        <span className="flex items-center gap-2">
          {children}
          <button type="button" onClick={() => copy(prompt)} className={cn(buttonVariants(), 'rounded-full px-3.5')}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </span>
      </div>
    </div>
  )
}

/**
 * The last step of setup: until an app acts as the agent, the MCP URL and the line naming the agent; once one does,
 * who is connected and the URL for another app.
 */
export function AgentConnect({
  agent,
  connected,
}: {
  agent: { name: string; agentId: string }
  /** "ChatGPT is connected as Scout.", or null while no app acts as the agent. */
  connected: string | null
}) {
  if (connected === null) return <StartPrompt agent={agent} />
  return (
    <div className="grid w-full gap-2 text-left">
      <p className="text-sm text-muted-foreground">{connected} To connect another app, add this MCP URL:</p>
      <McpUrlRow />
    </div>
  )
}
