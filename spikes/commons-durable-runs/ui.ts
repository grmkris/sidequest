import { forecast, minutes } from './simulation.ts'
import { ready } from './model.ts'
import type { Action, Entry, Mission, RunMode, Ticket } from './model.ts'
import type { SimulatedReceipt, Snapshot } from './store.ts'

interface View extends Snapshot {
  simulatedReceipts: SimulatedReceipt[]
  boot: string
}
let current: View | undefined
let busy = false
let mode: RunMode = 'parallel'
let playing = false
let timer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}

function target(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing preview element: ${id}`)
  return node
}

function button(label: string, action: Action, ticketId = '', secondary = false): HTMLButtonElement {
  const node = element('button', label, secondary ? '' : 'primary')
  node.type = 'button'
  node.dataset.key = `${ticketId}-${action}`
  node.disabled = busy
  node.addEventListener('click', () => {
    void command(action, ticketId)
  })
  return node
}

function localButton(label: string, key: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', label)
  node.type = 'button'
  node.dataset.key = `simulation-${key}`
  node.addEventListener('click', onClick)
  return node
}

function scheduleTick(): void {
  clearTimeout(timer)
  if (!playing || busy || current?.mission.simulation?.status !== 'running') return
  if (!current.mission.tickets.some((ticket) => ticket.status === 'running')) return
  timer = setTimeout(() => void command('advance', ''), 650)
}

function modeChoices(mission: Mission): HTMLElement {
  const choices = element('div', '', 'mode-choices')
  choices.setAttribute('role', 'group')
  choices.setAttribute('aria-label', 'Execution mode')
  for (const option of ['parallel', 'sequential'] as const) {
    const choice = localButton(option === 'parallel' ? 'Parallel' : 'Sequential', option, () => {
      mode = option
      if (current) render(current, `simulation-${option}`)
    })
    choice.setAttribute('aria-pressed', String(mode === option))
    choice.disabled = !!mission.simulation || mission.tickets.some((t) => t.attempt > 0)
    choices.append(choice)
  }
  return choices
}

function runningControls(mission: Mission, actions: HTMLElement): string {
  const advancing = mission.tickets.some((t) => t.status === 'running')
  const status = `${mission.simulation?.elapsed ?? 0} simulated min saved. ${advancing ? (playing ? 'Playing · 1 simulated minute per tick.' : 'Playback paused. Your progress is saved.') : 'Waiting for your review. Accept a delivery or request changes.'}`
  if (advancing) {
    actions.append(
      localButton(playing ? 'Pause playback' : 'Play simulation', 'play', () => {
        playing = !playing
        if (current) render(current, 'simulation-play')
        scheduleTick()
      }),
    )
    if (!playing) actions.append(button('Next minute', 'advance', '', true))
  }
  actions.append(button('Cut power', 'interrupt', '', true))
  return status
}

function simulationControls(mission: Mission): { actions: HTMLElement; status: string } {
  const actions = element('div', '', 'actions simulation-controls')
  const simulation = mission.simulation
  let status =
    mode === 'parallel'
      ? 'Scout and Listener can work together. Scribe waits for both accepted results.'
      : 'One worker runs at a time. Independent tickets wait in the queue too.'
  if (!simulation && mission.tickets.every((t) => t.attempt === 0)) {
    const start = button('Run simulation', mode === 'parallel' ? 'run_parallel' : 'run_sequential')
    start.disabled = !mission.approved
    actions.append(start)
    if (!mission.approved) status += ' Approve the plan to begin.'
  } else if (simulation?.status === 'running') {
    status = runningControls(mission, actions)
  } else if (simulation?.status === 'interrupted') {
    status = `Power cut at ${simulation.elapsed} simulated min. Progress and accepted work are saved. Resume without repeating them.`
    actions.append(button('Resume saved run', 'resume'))
  } else if (simulation?.status === 'complete') {
    status = `Completed in ${simulation.elapsed} simulated work min. All deliveries accepted. Settle each reward to try another run.`
  } else {
    status = 'Manual walkthrough in progress. Finish these tickets to start a fresh simulation.'
  }
  if (mission.tickets.every((t) => t.payment === 'confirmed')) {
    status =
      'All rewards settled in the simulation. Start another run to compare modes; the old journal and receipts stay saved.'
    actions.append(button('New simulation', 'new_run'))
  }
  return { actions, status }
}

function simulator(mission: Mission): HTMLElement {
  const panel = element('section', '', 'simulator')
  panel.id = 'simulator'
  panel.tabIndex = -1
  panel.setAttribute('aria-label', 'Workflow simulation')
  const parallel = forecast(mission, 'parallel')
  const sequential = forecast(mission, 'sequential')
  const selected = mode === 'parallel' ? parallel : sequential
  const choices = modeChoices(mission)
  const stats = element('p', '', 'forecast')
  stats.append(
    element('strong', `${selected.elapsed} min`),
    document.createTextNode(` simulated work · ${selected.reward} demo credits`),
  )
  panel.append(
    choices,
    stats,
    element(
      'p',
      `Parallel ${parallel.elapsed} min / sequential ${sequential.elapsed} min. Critical path: ${selected.criticalPath.join(' → ')}.`,
      'meta',
    ),
  )
  panel.append(
    element('p', 'Fixed example durations; excludes review waits, outages, rework and execution costs.', 'meta'),
  )
  const { actions, status } = simulationControls(mission)
  panel.append(actions, element('p', status, 'run-status'))
  panel.append(element('p', 'Solid lines: required inputs. Dashed line: sequential scheduling order.', 'graph-legend'))
  return panel
}

function graphEdges(mission: Mission) {
  const edges = mission.tickets.flatMap((ticket) =>
    ticket.dependsOn.map((id) => ({ from: id, to: ticket.id, queue: false })),
  )
  if (mode === 'sequential') {
    for (let i = 1; i < mission.tickets.length; i++) {
      const previous = mission.tickets[i - 1]
      const ticket = mission.tickets[i]
      if (previous && ticket && !ticket.dependsOn.includes(previous.id))
        edges.push({ from: previous.id, to: ticket.id, queue: true })
    }
  }
  return edges
}

function wirePath(from: DOMRect, to: DOMRect, bounds: DOMRect): SVGPathElement {
  const horizontal = to.left >= from.right
  const x1 = (horizontal ? from.right : from.left + from.width / 2) - bounds.left
  const y1 = (horizontal ? from.top + from.height / 2 : from.bottom) - bounds.top
  const x2 = (horizontal ? to.left : to.left + to.width / 2) - bounds.left
  const y2 = (horizontal ? to.top + to.height / 2 : to.top) - bounds.top
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    horizontal
      ? `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`,
  )
  return path
}

/** Wires follow the responsive cards; their text dependencies remain available without SVG. */
function drawWires(graph: HTMLElement, svg: SVGSVGElement, mission: Mission): void {
  const bounds = graph.getBoundingClientRect()
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`)
  const edges = graphEdges(mission)
  svg.replaceChildren()
  for (const edge of edges) {
    const from = document.getElementById(`ticket-${edge.from}`)?.getBoundingClientRect()
    const to = document.getElementById(`ticket-${edge.to}`)?.getBoundingClientRect()
    if (!from || !to) continue
    const path = wirePath(from, to, bounds)
    path.setAttribute('class', edge.queue ? 'queue-wire' : 'dependency-wire')
    svg.append(path)
  }
}

function ticketStatus(mission: Mission, ticket: Ticket): string {
  if (ticket.payment === 'confirmed') return 'Paid · simulated'
  if (ticket.payment === 'pending') return 'Payment unconfirmed'
  if (ticket.status === 'accepted') return 'Accepted · payment due'
  if (ticket.status === 'review') return 'Needs your review'
  if (ticket.status === 'running')
    return mission.simulation?.status === 'interrupted'
      ? 'Interrupted · progress saved'
      : `Working · attempt ${ticket.attempt}`
  if (mission.simulation?.mode === 'sequential' && ready(mission, ticket)) return 'Queued · one worker at a time'
  if (!mission.approved) return 'Awaiting plan approval'
  return ready(mission, ticket) ? 'Ready to start' : `Waiting for ticket ${ticket.dependsOn.join(', ')}`
}

function ticketActions(mission: Mission, ticket: Ticket): HTMLElement {
  const actions = element('div', '', 'actions')
  const add = (label: string, action: Action, secondary = false) =>
    actions.append(button(label, action, ticket.id, secondary))
  if (!mission.approved) return actions
  if (!mission.simulation && ticket.status === 'waiting' && ready(mission, ticket))
    add(ticket.attempt ? 'Retry simulated work' : 'Start simulated work', 'start')
  if (!mission.simulation && ticket.status === 'running') add('Submit example delivery', 'submit')
  if (ticket.status === 'review' && mission.simulation?.status !== 'interrupted') {
    add('Accept delivery', 'accept')
    add('Request changes', 'revise', true)
  }
  if (ticket.status === 'accepted' && ticket.payment === 'none') {
    add('Simulate payment', 'pay')
    add('Pay & lose reply', 'lose_reply', true)
  }
  if (ticket.payment === 'pending') add('Reconcile payment', 'reconcile')
  return actions
}

function ticketRow(mission: Mission, ticket: Ticket): HTMLElement {
  const row = element('article', '', 'ticket')
  row.id = `ticket-${ticket.id}`
  row.tabIndex = -1
  row.setAttribute('aria-labelledby', `title-${ticket.id}`)
  row.dataset.status = ticket.status
  const number = element('span', ticket.id, 'ticket-number')
  number.setAttribute('aria-hidden', 'true')
  const body = element('div', '', 'ticket-body')
  const title = element('h3', ticket.title)
  title.id = `title-${ticket.id}`
  const top = element('div', '', 'ticket-top')
  top.append(
    title,
    element('span', ticketStatus(mission, ticket), `status ${ticket.payment === 'pending' ? 'pending' : ''}`),
  )
  body.append(top, element('p', `${ticket.worker} · ${minutes(ticket)} min · ${ticket.reward} demo credits`, 'meta'))
  const brief = element('details', '', 'ticket-brief')
  brief.id = `criteria-${ticket.id}`
  brief.append(element('summary', 'Acceptance criteria'), element('p', ticket.criteria))
  body.append(brief)
  if (ticket.dependsOn.length)
    body.append(element('p', `Starts after ticket ${ticket.dependsOn.join(', ')} is accepted.`, 'dependency'))
  if (ticket.status === 'review' || ticket.status === 'accepted') body.append(element('blockquote', ticket.sample))
  if (ticket.payment === 'pending')
    body.append(
      element('p', 'The reply was lost. Check the original operation before sending anything again.', 'pending-note'),
    )
  body.append(ticketActions(mission, ticket))
  if (mission.simulation && ticket.attempt > 0) {
    const progress = element('progress')
    progress.max = minutes(ticket)
    progress.value = mission.simulation.progress[ticket.id] ?? 0
    progress.setAttribute('aria-label', `${ticket.worker} simulated work`)
    body.prepend(element('p', `${progress.value} / ${progress.max} simulated min saved`, 'meta'), progress)
  }
  row.append(number, body)
  return row
}

function summary(view: View): HTMLElement {
  const aside = element('aside', '', 'summary')
  aside.setAttribute('aria-label', 'Mission agreement')
  aside.append(element('h2', 'The agreement'))
  const accepted = view.mission.tickets.filter((t) => t.status === 'accepted')
  const confirmed = view.mission.tickets.filter((t) => t.payment === 'confirmed').reduce((sum, t) => sum + t.reward, 0)
  const items = [
    ['Coordinator', 'Atlas · simulated'],
    ['Spending cap', `${view.mission.budget} demo credits`],
    ['Accepted work', `${accepted.length} of ${view.mission.tickets.length} tickets`],
    ['Confirmed payment', `${confirmed} demo credits`],
  ]
  const list = element('dl')
  for (const [label, value] of items) list.append(element('dt', label), element('dd', value))
  aside.append(
    list,
    element(
      'p',
      'Each worker earns their own reward. A delayed next step does not erase accepted work.',
      'agreement-note',
    ),
  )
  const proof = element('details', '', 'proof')
  proof.id = 'payment-evidence'
  proof.append(element('summary', 'Simulated payment evidence'))
  proof.append(
    element(
      'p',
      `${view.simulatedReceipts.filter((r) => r.operationId.startsWith(`${view.mission.id}/`)).length} provider receipts for this run. This separate ledger can contain a payment the coordinator has not confirmed yet.`,
    ),
  )
  for (const receipt of view.simulatedReceipts.filter((r) => r.operationId.startsWith(`${view.mission.id}/`))) {
    proof.append(
      element('p', `${receipt.worker}: ${receipt.amount} demo credits`, 'meta'),
      element('code', receipt.operationId),
    )
  }
  aside.append(proof)
  return aside
}

function eventLabel(entry: Entry): string {
  const event = entry.event
  if (event.type === 'plan_created')
    return `Atlas proposed a ${event.mission.tickets.length}-ticket plan. Run ${event.mission.id.slice(0, 8)}.`
  if (event.type === 'plan_approved') return 'Plan approved with a cap of 300 demo credits.'
  if (event.type === 'simulation_started')
    return `${event.mode === 'parallel' ? 'Parallel' : 'Sequential'} simulation started.`
  if (event.type === 'simulation_advanced') return `Minute ${event.elapsed}: active work checkpoint saved.`
  if (event.type === 'simulation_interrupted') return 'Power cut injected. Progress saved; no more work advances.'
  if (event.type === 'simulation_resumed') return 'Resumed saved progress. Accepted work is kept.'
  if (event.type === 'simulation_completed')
    return 'All deliveries accepted. Simulation complete; payments remain separate.'
  const labels = {
    work_started: 'Simulated worker started',
    work_submitted: 'Example delivery submitted for review',
    changes_requested: 'Changes requested; downstream work stays blocked',
    work_accepted: 'Delivery accepted; dependent work can start',
    payment_prepared: 'Payment intent saved before contacting the simulated provider',
    payment_confirmed: 'Simulated payment confirmed',
  }
  const recovered = event.type === 'payment_confirmed' && event.recovered ? ' · original receipt recovered' : ''
  return `Ticket ${event.ticketId}: ${labels[event.type]}${recovered}`
}

function restoreFocus(focusKey?: string): void {
  if (focusKey) {
    const active = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-key]')).find(
      (b) => b.dataset.key === focusKey,
    )
    const fallback = document.getElementById(
      focusKey.startsWith('simulation-') || focusKey.startsWith('-') ? 'simulator' : `ticket-${focusKey.split('-')[0]}`,
    )
    ;(active ?? fallback)?.focus({ preventScroll: true })
  }
}

function render(view: View, focusKey?: string): void {
  const openDetails = Array.from(document.querySelectorAll<HTMLDetailsElement>('#mission details[open]')).map(
    (node) => node.id,
  )
  if (current && current.mission.id !== view.mission.id) {
    playing = false
    mode = 'parallel'
  }
  current = view
  const mission = view.mission
  if (mission.simulation) mode = mission.simulation.mode
  if (mission.simulation?.status !== 'running') playing = false
  const section = element('section', '', 'plan')
  section.setAttribute('aria-label', 'Mission plan')
  const heading = element('div', '', 'plan-heading')
  heading.append(
    element('span', mission.approved ? 'Approved plan' : 'Atlas proposes', 'plan-label'),
    element('h2', mission.title),
  )
  heading.append(element('p', 'Community brief: “Help a new agent understand their first paid hire.”'))
  if (!mission.approved) heading.append(button('Approve plan · 300 demo credits', 'approve'))
  section.append(heading)
  section.append(simulator(mission))
  const graph = element('div', '', 'workflow-graph')
  graph.dataset.mode = mode
  graph.setAttribute('aria-label', `${mode} workflow`)
  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  wires.classList.add('wires')
  wires.setAttribute('aria-hidden', 'true')
  graph.append(wires)
  for (const ticket of mission.tickets) graph.append(ticketRow(mission, ticket))
  section.append(graph)
  const layout = element('div', '', 'mission-layout')
  layout.append(section, summary(view))
  observer?.disconnect()
  target('mission').replaceChildren(layout)
  for (const id of openDetails) {
    const node = document.getElementById(id)
    if (node instanceof HTMLDetailsElement) node.open = true
  }
  observer = new ResizeObserver(() => drawWires(graph, wires, mission))
  observer.observe(graph)
  drawWires(graph, wires, mission)
  target('journal-count').textContent = `· ${view.journal.length} saved events`
  target('events').replaceChildren(
    ...view.journal.toReversed().map((entry) => {
      const row = element('li')
      const time = element('time', new Date(entry.at).toLocaleTimeString())
      time.dateTime = entry.at
      row.append(element('span', String(entry.seq), 'sequence'), element('span', eventLabel(entry)), time)
      return row
    }),
  )
  restoreFocus(focusKey)
}

async function read(url: string, body?: object): Promise<View> {
  const response = await fetch(
    url,
    body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {},
  )
  if (!response.ok) {
    // SAFETY: the same-origin experiment server emits this error envelope for every non-2xx response.
    const error = (await response.json()) as { error: string }
    throw new Error(error.error)
  }
  // SAFETY: this view comes exclusively from the local typed preview server, with no user-supplied HTML.
  return (await response.json()) as View
}

async function update(url: string, body: object | undefined, message: string): Promise<void> {
  if (busy) return
  busy = true
  const active = document.activeElement
  const focusKey = active instanceof HTMLButtonElement ? active.dataset.key : undefined
  for (const node of document.querySelectorAll<HTMLButtonElement>('button')) node.disabled = true
  try {
    const view = await read(url, body)
    busy = false
    render(view, focusKey)
    target('feedback').textContent = message
  } catch (error) {
    target('feedback').textContent = error instanceof Error ? error.message : 'Could not read the preview.'
    playing = false
    busy = false
    if (current) render(current, focusKey)
  } finally {
    busy = false
    for (const id of ['refresh', 'recover']) {
      const node = target(id)
      if (node instanceof HTMLButtonElement) node.disabled = false
    }
    scheduleTick()
  }
}

async function command(action: Action, ticketId: string): Promise<void> {
  if (!current || busy) return
  if (action === 'run_parallel' || action === 'run_sequential' || action === 'resume') playing = true
  if (action === 'interrupt') playing = false
  const message =
    action === 'lose_reply'
      ? 'Reply lost. Reload from disk, then reconcile the pending payment.'
      : 'Step saved to the journal.'
  await update('/api/command', { id: crypto.randomUUID(), revision: current.revision, action, ticketId }, message)
}

target('recover').addEventListener('click', () => {
  playing = false
  void update('/api/recover', {}, 'Reopened the database and replayed the journal. No work was dispatched.')
})
target('refresh').addEventListener('click', () => {
  playing = false
  void update('/api/state', undefined, 'Showing the latest saved state.')
})
void update('/api/state', undefined, 'Try the plan. Every step is saved on this computer.')
