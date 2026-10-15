import { Link } from '@tanstack/react-router'
import { Check, Copy, Plug } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { McpUrlRow, startOrigin, startPrompt, useCopy } from './AgentStartLink.tsx'
import { useWide } from './CardLink.tsx'
import { Sheet } from './Sheet.tsx'
import { Button } from './ui/button.tsx'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover.tsx'

/** The short setup panel shared by the wide popover and the phone sheet. */
export function ConnectPanel({ onNavigate, showTitle = true }: { onNavigate?: () => void; showTitle?: boolean }) {
  const prompt = startPrompt(startOrigin())
  const [copied, copy] = useCopy()
  return (
    <div className="grid gap-4 p-2.5 text-left">
      {showTitle && <h2 className="px-1 text-base font-semibold tracking-tight">Connect your agent</h2>}
      <section className="grid gap-1.5">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">1. Add Sidequest as a connector (MCP server)</h3>
        <McpUrlRow />
      </section>
      <section className="grid gap-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">2. Then send it this</h3>
        <div className="rounded-xl bg-muted/60 px-3 py-2.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
          {prompt}
        </div>
        <Button className="w-full" onClick={() => copy(prompt)}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? 'Copied' : 'Copy prompt'}
        </Button>
      </section>
      <p className="px-1 text-xs text-muted-foreground">Works with ChatGPT, Claude, Codex, Cursor and Grok.</p>
      <Link
        to="/connect"
        onClick={onNavigate}
        className="px-1 text-sm text-primary underline decoration-current/35 underline-offset-4 hover:decoration-current"
      >
        More ways to connect
      </Link>
    </div>
  )
}

type TriggerVariant = 'header' | 'sidebar' | 'icon'

function Trigger({ kind, ...props }: { kind: TriggerVariant } & Omit<ComponentProps<typeof Button>, 'variant'>) {
  if (kind === 'sidebar')
    return (
      <Button
        variant="ghost"
        className="w-full justify-start gap-2 rounded-md px-2 text-sm font-medium text-sidebar-foreground [@media(hover:hover)]:hover:bg-sidebar-accent/70"
        {...props}
      >
        <Plug aria-hidden className="size-4 text-muted-foreground" />
        Connect your agent
      </Button>
    )
  if (kind === 'icon')
    return (
      <Button variant="ghost" size="icon" aria-label="Connect your agent" className="size-11 rounded-full" {...props}>
        <Plug aria-hidden className="size-5" />
      </Button>
    )
  return (
    <Button variant="outline" className="rounded-full px-3 sm:px-3.5" {...props}>
      <Plug aria-hidden className="size-4" />
      <span className="hidden sm:inline">Connect agent</span>
      <span className="sm:hidden">Connect</span>
    </Button>
  )
}

/** A responsive agent connector: anchored popover on wide screens and a bottom sheet on phones. */
export function ConnectAgent({ variant }: { variant: TriggerVariant }) {
  const wide = useWide()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  if (wide)
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Trigger kind={variant} />} />
        <PopoverContent size="panel" align="end" sideOffset={6}>
          <PopoverTitle className="sr-only">Connect your agent</PopoverTitle>
          <ConnectPanel onNavigate={close} />
        </PopoverContent>
      </Popover>
    )
  return (
    <>
      <Trigger kind={variant} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
      <Sheet open={open} onClose={close} title="Connect your agent">
        <ConnectPanel onNavigate={close} showTitle={false} />
      </Sheet>
    </>
  )
}
