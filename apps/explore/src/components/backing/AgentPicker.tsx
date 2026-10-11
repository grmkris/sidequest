import { ChevronRight, Search } from 'lucide-react'
import { useState } from 'react'
import type { Address } from 'viem'
import { useAgents } from '../../agent-summary.ts'
import type { BackableAgent } from '../../backing-agents.ts'
import { directoryLiveness } from '../../directory-presence.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { Input } from '../ui/input.tsx'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '../ui/item.tsx'

/** Past this many agents the picker offers a search. */
const SEARCH_FROM = 6

/**
 * Your own agents first, then the most active: around now (a fresh heartbeat or a recent MCP call), then by work
 * delivered. The order the list was given breaks ties.
 */
export function rankBackable(
  agents: readonly BackableAgent[],
  delivered: ReadonlyMap<string, number>,
  now: number,
): BackableAgent[] {
  const live = (a: BackableAgent) =>
    a.presence === undefined ? 0 : directoryLiveness(a.presence, now) === 'idle' ? 0 : 1
  const done = (a: BackableAgent) => (a.agentId === null ? 0 : (delivered.get(a.agentId) ?? 0))
  return agents.toSorted((a, b) => Number(b.yours) - Number(a.yours) || live(b) - live(a) || done(b) - done(a))
}

function PickerSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <label htmlFor="agent-picker-search" className="sr-only">
        Search agents
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id="agent-picker-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Name or Agent ID"
        className="pl-8"
      />
    </div>
  )
}

/** "Back an agent": the agents the wallet can back, its own first, then the most active; picking one opens the form. */
export function AgentPicker({
  agents,
  onPick,
}: {
  agents: readonly BackableAgent[]
  onPick: (wallet: Address) => void
}) {
  const [q, setQ] = useState('')
  const summaries = useAgents()
  const delivered = new Map((summaries.data?.agents ?? []).map((a) => [a.agentId, a.completed]))
  const now = Date.now() / 1000
  const needle = q.trim().toLowerCase()
  const shown = rankBackable(agents, delivered, now).filter(
    (a) => needle === '' || a.name.toLowerCase().includes(needle) || a.agentId === needle.replace(/^#/, ''),
  )
  if (agents.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No agents to back yet</EmptyTitle>
          <EmptyDescription>Agents appear here once they are listed in the directory.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <div className="grid gap-3">
      {agents.length > SEARCH_FROM && <PickerSearch value={q} onChange={setQ} />}
      <ItemGroup className="max-h-[60dvh] overflow-y-auto">
        {shown.map((agent) => {
          const done = agent.agentId === null ? 0 : (delivered.get(agent.agentId) ?? 0)
          return (
            <Item
              key={agent.wallet}
              render={<button type="button" aria-label={`Back ${agent.name}`} onClick={() => onPick(agent.wallet)} />}
            >
              <ItemMedia>
                <AgentOrb
                  agentId={agent.agentId ?? agent.wallet}
                  {...(agent.presence === undefined ? {} : { status: directoryLiveness(agent.presence, now) })}
                />
              </ItemMedia>
              <ItemContent className="min-w-0 flex-1 text-left">
                <ItemTitle className="block truncate font-medium">{agent.name}</ItemTitle>
                <span className="block text-ui text-muted-foreground">
                  {[
                    agent.yours ? 'Your agent' : null,
                    agent.agentId === null ? null : `Agent ID ${agent.agentId}`,
                    done > 0 ? `${done} delivered` : null,
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </span>
              </ItemContent>
              <ItemActions>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          )
        })}
        {shown.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">No agent matches “{q}”.</p>}
      </ItemGroup>
    </div>
  )
}
