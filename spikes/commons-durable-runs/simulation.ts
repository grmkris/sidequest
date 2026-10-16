import type { Mission, RunMode, Ticket } from './model.ts'

/** Synthetic minutes, not estimates of real agent performance. Legacy tickets use a one-minute example. */
export const minutes = (ticket: Ticket): number => ticket.minutes ?? 1

export interface Forecast {
  elapsed: number
  reward: number
  criticalPath: string[]
  slots: { ticketId: string; start: number; finish: number }[]
}

type Slot = Forecast['slots'][number]

function takeReady(pending: Ticket[], slots: Slot[]): Ticket {
  const index = pending.findIndex((ticket) => ticket.dependsOn.every((id) => slots.some((s) => s.ticketId === id)))
  if (index < 0) throw new Error('Workflow contains a cycle or missing dependency.')
  const ticket = pending.splice(index, 1)[0]
  if (!ticket) throw new Error('Missing ticket.')
  if (slots.some((s) => s.ticketId === ticket.id)) throw new Error('Duplicate ticket ID.')
  if (!Number.isSafeInteger(minutes(ticket)) || minutes(ticket) <= 0) throw new Error('Invalid work duration.')
  return ticket
}

function predecessor(ticket: Ticket, slots: Slot[], mode: RunMode): Slot | undefined {
  if (mode === 'sequential') return slots.at(-1)
  return slots.filter((s) => ticket.dependsOn.includes(s.ticketId)).toSorted((a, b) => b.finish - a.finish)[0]
}

/** Deterministic, no-rework forecast with instant reviews and no outages. No side effects. */
export function forecast(mission: Mission, mode: RunMode): Forecast {
  const pending = [...mission.tickets]
  const slots: Slot[] = []
  const paths = new Map<string, string[]>()
  while (pending.length) {
    const ticket = takeReady(pending, slots)
    const previous = predecessor(ticket, slots, mode)
    const start = previous?.finish ?? 0
    paths.set(ticket.id, [...(paths.get(previous?.ticketId ?? '') ?? []), ticket.id])
    slots.push({ ticketId: ticket.id, start, finish: start + minutes(ticket) })
  }
  const last = slots.toSorted((a, b) => b.finish - a.finish)[0]
  return {
    elapsed: last?.finish ?? 0,
    reward: mission.tickets.reduce((sum, ticket) => sum + ticket.reward, 0),
    criticalPath: paths.get(last?.ticketId ?? '') ?? [],
    slots,
  }
}
