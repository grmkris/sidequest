/**
 * The parts of backing that only Account › Backing shows, beside `BackingManager`: the backing form and the agent
 * picker as sheets, and bringing the confirm step into view once a sheet closes into it.
 * Presentation only; the transactions stay in `BackingManager`.
 */
import { type ReactNode, useEffect } from 'react'
import type { Address } from 'viem'
import type { BackableAgent } from '../../backing-agents.ts'
import { DELEGATION_RISK, factoryValue } from '../DelegationPositions.tsx'
import { Stat } from '../kit.tsx'
import { Sheet } from '../Sheet.tsx'
import { Disclosure } from '../ui/disclosure.tsx'
import { Button } from '../ui/button.tsx'
import { AgentPicker } from './AgentPicker.tsx'

export function BackingSheets({
  open,
  onClose,
  mode,
  own,
  name,
  form,
  busy,
  agents,
  onPick,
}: {
  open: 'form' | 'pick' | null
  onClose: () => void
  mode: 'add' | 'leave'
  /** The form is for the signed-in wallet's own account. */
  own: boolean
  /** The backed account's name, for the form's title. */
  name: string
  form: ReactNode
  busy: boolean
  agents: readonly BackableAgent[]
  onPick: (wallet: Address) => void
}) {
  return (
    <>
      <Sheet
        open={open === 'form'}
        onClose={onClose}
        title={mode === 'leave' ? `Leave ${name}` : own ? 'Back your wallet' : `Back ${name}`}
        walletPrompt={busy}
      >
        <BackingRisk />
        {form}
      </Sheet>
      <Sheet open={open === 'pick'} onClose={onClose} title="Back an agent">
        <AgentPicker agents={agents} onPick={onPick} />
      </Sheet>
    </>
  )
}

/**
 * An agent page's backing form in a sheet: the SIDE in the wallet, the risks, then the form. Once the form is sent the
 * sheet closes into the confirm step on the page, as Account's does.
 */
export function AgentFormSheet({
  open,
  onClose,
  title,
  busy,
  wallet,
  form,
}: {
  open: boolean
  onClose: () => void
  title: string
  busy: boolean
  /** SIDE in the signed-in wallet, when read. */
  wallet: bigint | undefined
  form: ReactNode
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} walletPrompt={busy}>
      {wallet !== undefined && (
        <dl>
          <Stat label="In your wallet" value={factoryValue(wallet)} />
        </dl>
      )}
      <BackingRisk />
      {form}
    </Sheet>
  )
}

/** The backing risk in one line, and the whole of it a tap away, rather than a block of small print over the form. */
function BackingRisk() {
  return (
    <Disclosure summary="If the agent is slashed, every backer loses the same share" className="-mx-1 -my-1">
      <p className="px-1 pt-1 pb-2 text-ui text-pretty text-muted-foreground">{DELEGATION_RISK}</p>
    </Disclosure>
  )
}

/** Scroll the confirm step (`id`) into view when an operation is saved or restored, honouring reduced motion. */
export function useReveal(id: string, key: string | undefined) {
  useEffect(() => {
    if (key === undefined) return
    document.getElementById(id)?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [id, key])
}

/** The positions' chain reads failed: say what that does and does not mean, and offer a retry. */
export function PositionsUnavailable({ lastKnown, onRetry }: { lastKnown: boolean; onRetry: () => void }) {
  return (
    <output className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
      <p>
        {lastKnown
          ? 'Showing last-known positions. Actions are paused until chain facts refresh.'
          : 'Your positions could not be read. This does not mean they are gone.'}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </output>
  )
}
