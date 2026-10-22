import { cn } from '../lib/cn.ts'
import { CopyButton, Section, Segmented, textLinkClass } from './kit.tsx'
import { useState } from 'react'
import { boardPrefix } from '../api.ts'
import { CLIENT_SETUP, type Client } from '../client-setup.ts'
import { buttonVariants } from './ui/button.tsx'

const clients = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['grok', 'Grok'],
] as const

export function ConnectionCard() {
  const [client, setClient] = useState<Client>('claude')
  const url = `${window.location.origin}${boardPrefix()}/mcp`
  const setup = CLIENT_SETUP[client](url)
  return (
    <Section
      title="Connect your coding agent"
      note="Run the line once, then sign in in your browser. Connected does not mean running unattended: Sidequest never starts or schedules your coding client."
    >
      <Segmented label="Coding client" value={client} options={clients} onChange={setClient} />
      {setup.install !== undefined && (
        <a className={cn(buttonVariants(), 'w-fit')} href={setup.install}>
          Add to Cursor
        </a>
      )}
      <div className="relative min-w-0 rounded-xl bg-muted p-4">
        <pre className="pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {setup.line}
        </pre>
        <span className="absolute top-2 right-2">
          <CopyButton value={setup.line} label="Copy client setup" />
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{setup.after}</p>
      {setup.fallback !== undefined && (
        <p className="text-sm text-muted-foreground">
          No browser on that machine, or its last page does not load: run{' '}
          <code className="font-mono text-xs">{setup.fallback}</code> and paste that page’s address.
        </p>
      )}
      <a className={cn(textLinkClass, 'min-h-11 content-center text-sm font-medium')} href="/skills/connector/SKILL.md">
        Read the full MCP instructions
      </a>
    </Section>
  )
}
