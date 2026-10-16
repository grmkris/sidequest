import { forecast, minutes } from './simulation.ts'

/** Experiment only. No agent, wallet, board or chain integration. */
export interface Ticket {
  id: string
  title: string
  worker: string
  reward: number
  dependsOn: string[]
  /** Synthetic work duration. Optional for journals created before the simulator. */
  minutes?: number
  criteria: string
  sample: string
  status: 'waiting' | 'running' | 'review' | 'accepted'
  attempt: number
  payment: 'none' | 'pending' | 'confirmed'
}

export type RunMode = 'parallel' | 'sequential'
export interface Simulation {
  mode: RunMode
  elapsed: number
  status: 'running' | 'interrupted' | 'complete'
  progress: Record<string, number>
}

export interface Mission {
  id: string
  title: string
  budget: number
  approved: boolean
  tickets: Ticket[]
  simulation?: Simulation
}

export type Event =
  | { type: 'plan_created'; mission: Mission }
  | { type: 'plan_approved' }
  | { type: 'simulation_started'; mode: RunMode }
  | { type: 'simulation_advanced'; elapsed: number; progress: Record<string, number> }
  | { type: 'simulation_interrupted' }
  | { type: 'simulation_resumed' }
  | { type: 'simulation_completed' }
  | { type: 'work_started' | 'work_submitted' | 'changes_requested' | 'work_accepted'; ticketId: string }
  | { type: 'payment_prepared'; ticketId: string; operationId: string }
  | { type: 'payment_confirmed'; ticketId: string; operationId: string; receipt: string; recovered: boolean }

export interface Entry {
  seq: number
  at: string
  event: Event
}

export type Action =
  | 'approve'
  | 'start'
  | 'submit'
  | 'revise'
  | 'accept'
  | 'pay'
  | 'lose_reply'
  | 'reconcile'
  | 'run_parallel'
  | 'run_sequential'
  | 'advance'
  | 'interrupt'
  | 'resume'
  | 'new_run'
export interface Command {
  id: string
  revision: number
  action: Action
  ticketId: string
}

export class Conflict extends Error {}

const proposedTicket = (
  fields: Pick<Ticket, 'id' | 'title' | 'worker' | 'reward' | 'dependsOn' | 'criteria' | 'sample' | 'minutes'>,
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
        reward: 60,
        minutes: 8,
        dependsOn: [],
        criteria: 'Three concrete friction points, each with a proposed fix.',
        sample:
          'Example delivery: clarify who pays, show the acceptance criteria before hiring, and explain what happens when a reply is lost.',
      }),
      proposedTicket({
        id: '02',
        title: 'Check worker and approver needs',
        worker: 'Listener',
        reward: 60,
        minutes: 12,
        dependsOn: [],
        criteria: 'Describe what the worker and approver each need before agreeing to a hire.',
        sample:
          'Example delivery: workers need a concrete result and deadline; approvers need evidence and agreed criteria.',
      }),
      proposedTicket({
        id: '03',
        title: 'Write the first-hire guide',
        worker: 'Scribe',
        reward: 120,
        minutes: 10,
        dependsOn: ['01', '02'],
        criteria: 'A short guide covering all accepted gaps, with a worked example.',
        sample:
          'Example delivery: agree the result and reward, select a worker, activate the hire, inspect the delivery, then settle from the recorded operation.',
      }),
      proposedTicket({
        id: '04',
        title: 'Check the guide end to end',
        worker: 'Verifier',
        reward: 60,
        minutes: 6,
        dependsOn: ['03'],
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

/** Fold one committed fact. No dispatch occurs during replay. */
function applyEvent(mission: Mission, event: Event): Mission {
  switch (event.type) {
    case 'plan_created':
      return structuredClone(event.mission)
    case 'plan_approved':
      mission.approved = true
      return mission
    case 'simulation_started':
      mission.simulation = { mode: event.mode, elapsed: 0, status: 'running', progress: {} }
      return mission
    case 'simulation_advanced':
      if (!mission.simulation) throw new Error('Simulation has not started.')
      mission.simulation.elapsed = event.elapsed
      mission.simulation.progress = { ...event.progress }
      return mission
    case 'simulation_interrupted':
    case 'simulation_resumed':
    case 'simulation_completed': {
      if (!mission.simulation) throw new Error('Simulation has not started.')
      const statuses = {
        simulation_interrupted: 'interrupted',
        simulation_resumed: 'running',
        simulation_completed: 'complete',
      } as const
      mission.simulation.status = statuses[event.type]
      return mission
    }
    case 'work_started':
    case 'work_submitted':
    case 'changes_requested':
    case 'work_accepted':
    case 'payment_prepared':
    case 'payment_confirmed':
      break
  }
  const ticket = findTicket(mission, event.ticketId)
  switch (event.type) {
    case 'work_started':
      ticket.status = 'running'
      ticket.attempt += 1
      if (mission.simulation) mission.simulation.progress[ticket.id] = 0
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
  return mission
}

/** Reconstruct from committed facts only. Reading or replaying never dispatches work. */
export function project(entries: Entry[]): Mission {
  const first = entries[0]?.event
  if (first?.type !== 'plan_created') throw new Error('Missing plan; refusing to invent replacement state.')
  return entries.slice(1).reduce((mission, entry) => applyEvent(mission, entry.event), structuredClone(first.mission))
}

function requireState(condition: boolean, message: string): void {
  if (!condition) throw new Conflict(message)
}

/** The only place commands become facts. An approval is scoped to this immutable example plan. */
function decideOne(mission: Mission, command: Command): Event | null {
  const { action } = command
  if (action === 'new_run') {
    requireState(
      mission.tickets.every((t) => t.status === 'accepted' && t.payment === 'confirmed'),
      'Finish and settle this example before creating another run.',
    )
    return { type: 'plan_created', mission: proposedMission(command.id) }
  }
  if (action === 'approve') {
    requireState(!mission.approved, 'This plan is already approved.')
    requireState(mission.tickets.reduce((sum, t) => sum + t.reward, 0) <= mission.budget, 'Plan exceeds its budget.')
    return { type: 'plan_approved' }
  }
  requireState(mission.approved, 'Approve the plan first.')
  const simulationEvent = decideSimulation(mission, action)
  if (simulationEvent) return simulationEvent
  return decideTicket(mission, command)
}

function advanceSimulation(mission: Mission): Event {
  const simulation = mission.simulation
  requireState(simulation?.status === 'running', 'Resume the simulation first.')
  if (!simulation) throw new Conflict('Missing simulation.')
  const running = mission.tickets.filter((t) => t.status === 'running')
  requireState(running.length > 0, 'Review the delivered work to continue.')
  const progress = { ...simulation.progress }
  for (const t of running) progress[t.id] = (progress[t.id] ?? 0) + 1
  return { type: 'simulation_advanced', elapsed: simulation.elapsed + 1, progress }
}

function decideSimulation(mission: Mission, action: Action): Event | undefined {
  const simulation = mission.simulation
  if (action === 'run_parallel' || action === 'run_sequential') {
    requireState(
      !simulation && mission.tickets.every((t) => t.attempt === 0),
      'Start a simulation before manually running tickets.',
    )
    const mode = action === 'run_parallel' ? 'parallel' : 'sequential'
    forecast(mission, mode)
    return { type: 'simulation_started', mode }
  }
  if (action === 'interrupt' || action === 'resume') {
    requireState(
      simulation?.status === (action === 'interrupt' ? 'running' : 'interrupted'),
      'The simulation cannot make that transition.',
    )
    return { type: action === 'interrupt' ? 'simulation_interrupted' : 'simulation_resumed' }
  }
  if (action === 'advance') return advanceSimulation(mission)
  return undefined
}

function decideTicket(mission: Mission, command: Command): Event | null {
  const { action, ticketId } = command
  const simulation = mission.simulation
  if (simulation && ['start', 'submit', 'accept', 'revise'].includes(action)) {
    requireState(simulation.status === 'running', 'Resume the simulation first.')
    requireState(action !== 'start' && action !== 'submit', 'The simulator schedules and delivers this work.')
  }
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
    case 'advance':
    case 'approve':
    case 'interrupt':
    case 'new_run':
    case 'resume':
    case 'run_parallel':
    case 'run_sequential':
      throw new Conflict('Unknown ticket action.')
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
    [
      'approve',
      'start',
      'submit',
      'revise',
      'accept',
      'pay',
      'lose_reply',
      'reconcile',
      'run_parallel',
      'run_sequential',
      'advance',
      'interrupt',
      'resume',
      'new_run',
    ].includes(value.action) &&
    typeof value.ticketId === 'string' &&
    ['', '01', '02', '03', '04'].includes(value.ticketId) &&
    Object.keys(value).length === 4
  )
}

function startReady(mission: Mission): Event[] {
  const available = mission.tickets.filter((t) => t.status === 'waiting' && ready(mission, t))
  if (mission.simulation?.mode === 'parallel') return available.map((t) => ({ type: 'work_started', ticketId: t.id }))
  if (mission.tickets.some((t) => t.status === 'running' || t.status === 'review')) return []
  return available.slice(0, 1).map((t) => ({ type: 'work_started', ticketId: t.id }))
}

/** A simulation command and every resulting transition are committed in one SQLite transaction. */
export function decide(mission: Mission, command: Command): Event[] {
  const event = decideOne(mission, command)
  if (!event) return []
  const events: Event[] = [event]
  const next = applyEvent(structuredClone(mission), event)
  const simulation = next.simulation
  if (!simulation || simulation.status !== 'running') return events
  for (const ticket of next.tickets) {
    if (ticket.status === 'running' && (simulation.progress[ticket.id] ?? 0) >= minutes(ticket)) {
      const submitted = { type: 'work_submitted', ticketId: ticket.id } as const
      events.push(submitted)
      applyEvent(next, submitted)
    }
  }
  if (next.tickets.every((t) => t.status === 'accepted')) events.push({ type: 'simulation_completed' })
  else events.push(...startReady(next))
  return events
}
