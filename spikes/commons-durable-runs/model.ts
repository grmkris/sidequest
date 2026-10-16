/** Experiment only. No agent, wallet, board or chain integration. */
export interface Ticket {
  id: string
  title: string
  worker: string
  reward: number
  dependsOn: string[]
  criteria: string
  sample: string
  status: 'waiting' | 'running' | 'review' | 'accepted'
  attempt: number
  payment: 'none' | 'pending' | 'confirmed'
}

export interface Mission {
  id: string
  title: string
  budget: number
  approved: boolean
  tickets: Ticket[]
}

export type Event =
  | { type: 'plan_created'; mission: Mission }
  | { type: 'plan_approved' }
  | { type: 'work_started' | 'work_submitted' | 'changes_requested' | 'work_accepted'; ticketId: string }
  | { type: 'payment_prepared'; ticketId: string; operationId: string }
  | { type: 'payment_confirmed'; ticketId: string; operationId: string; receipt: string; recovered: boolean }

export interface Entry {
  seq: number
  at: string
  event: Event
}

export type Action = 'approve' | 'start' | 'submit' | 'revise' | 'accept' | 'pay' | 'lose_reply' | 'reconcile'
export interface Command {
  id: string
  revision: number
  action: Action
  ticketId: string
}

export class Conflict extends Error {}

const proposedTicket = (
  fields: Pick<Ticket, 'id' | 'title' | 'worker' | 'reward' | 'dependsOn' | 'criteria' | 'sample'>,
): Ticket => ({ ...fields, status: 'waiting', attempt: 0, payment: 'none' })

export function proposedMission(id: string): Mission {
  return {
    id,
    title: 'Make the first agent hire easier',
    budget: 300,
    approved: false,
    tickets: [
      proposedTicket({
        id: '01',
        title: 'Map the onboarding gaps',
        worker: 'Scout',
        reward: 80,
        dependsOn: [],
        criteria: 'Three concrete friction points, each with a proposed fix.',
        sample:
          'Example delivery: clarify who pays, show the acceptance criteria before hiring, and explain what happens when a reply is lost.',
      }),
      proposedTicket({
        id: '02',
        title: 'Write the first-hire guide',
        worker: 'Scribe',
        reward: 140,
        dependsOn: ['01'],
        criteria: 'A short guide covering all accepted gaps, with a worked example.',
        sample:
          'Example delivery: agree the result and reward, select a worker, activate the hire, inspect the delivery, then settle from the recorded operation.',
      }),
      proposedTicket({
        id: '03',
        title: 'Check the guide end to end',
        worker: 'Verifier',
        reward: 80,
        dependsOn: ['02'],
        criteria: 'Check each instruction against the agreed brief and report remaining gaps.',
        sample:
          'Example delivery: all three gaps are addressed. A lost payment reply is shown as pending until its original receipt is found.',
      }),
    ],
  }
}

export function findTicket(mission: Mission, id: string): Ticket {
  const ticket = mission.tickets.find((item) => item.id === id)
  if (!ticket) throw new Conflict('Unknown ticket.')
  return ticket
}

export function ready(mission: Mission, ticket: Ticket): boolean {
  return mission.approved && ticket.dependsOn.every((id) => findTicket(mission, id).status === 'accepted')
}

export const paymentId = (mission: Mission, ticket: Ticket): string => `${mission.id}/${ticket.id}/reward-v1`

/** Reconstruct from committed facts only. Reading or replaying never dispatches work. */
export function project(entries: Entry[]): Mission {
  const first = entries[0]?.event
  if (first?.type !== 'plan_created') throw new Error('Missing plan; refusing to invent replacement state.')
  const mission = structuredClone(first.mission)
  for (const { event } of entries.slice(1)) {
    if (event.type === 'plan_created') throw new Error('Duplicate plan in journal.')
    if (event.type === 'plan_approved') {
      mission.approved = true
      continue
    }
    const ticket = findTicket(mission, event.ticketId)
    switch (event.type) {
      case 'work_started':
        ticket.status = 'running'
        ticket.attempt += 1
        break
      case 'work_submitted':
        ticket.status = 'review'
        break
      case 'changes_requested':
        ticket.status = 'waiting'
        break
      case 'work_accepted':
        ticket.status = 'accepted'
        break
      case 'payment_prepared':
        ticket.payment = 'pending'
        break
      case 'payment_confirmed':
        ticket.payment = 'confirmed'
        break
    }
  }
  return mission
}

function requireState(condition: boolean, message: string): void {
  if (!condition) throw new Conflict(message)
}

/** The only place commands become facts. An approval is scoped to this immutable example plan. */
export function decide(mission: Mission, command: Command): Event | null {
  const { action, ticketId } = command
  if (action === 'approve') {
    requireState(!mission.approved, 'This plan is already approved.')
    requireState(mission.tickets.reduce((sum, t) => sum + t.reward, 0) <= mission.budget, 'Plan exceeds its budget.')
    return { type: 'plan_approved' }
  }
  requireState(mission.approved, 'Approve the plan first.')
  const ticket = findTicket(mission, ticketId)
  switch (action) {
    case 'start':
      requireState(ticket.status === 'waiting' && ready(mission, ticket), 'Wait for accepted prerequisites.')
      return { type: 'work_started', ticketId }
    case 'submit':
      requireState(ticket.status === 'running', 'Start the ticket before submitting.')
      return { type: 'work_submitted', ticketId }
    case 'revise':
    case 'accept':
      requireState(ticket.status === 'review', 'A delivery must be awaiting review.')
      return { type: action === 'accept' ? 'work_accepted' : 'changes_requested', ticketId }
    case 'pay':
    case 'lose_reply':
      requireState(ticket.status === 'accepted' && ticket.payment === 'none', 'Only accepted, unpaid work can be paid.')
      return { type: 'payment_prepared', ticketId, operationId: paymentId(mission, ticket) }
    case 'reconcile':
      requireState(ticket.payment === 'pending', 'Only a pending payment can be reconciled.')
      return null
  }
}

export function isCommand(value: unknown): value is Command {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value && 'revision' in value && 'action' in value && 'ticketId' in value)) return false
  return (
    typeof value.id === 'string' &&
    /^[a-zA-Z0-9-]{1,80}$/.test(value.id) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.action === 'string' &&
    ['approve', 'start', 'submit', 'revise', 'accept', 'pay', 'lose_reply', 'reconcile'].includes(value.action) &&
    typeof value.ticketId === 'string' &&
    ['', '01', '02', '03'].includes(value.ticketId) &&
    Object.keys(value).length === 4
  )
}
