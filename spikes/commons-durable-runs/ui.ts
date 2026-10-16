import { ready } from './model.ts'
import type { Action, Entry, Mission, Ticket } from './model.ts'
import type { SimulatedReceipt, Snapshot } from './store.ts'

interface View extends Snapshot {
  simulatedReceipts: SimulatedReceipt[]
  boot: string
}
let current: View | undefined
let busy = false

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

function ticketStatus(mission: Mission, ticket: Ticket): string {
  if (ticket.payment === 'confirmed') return 'Paid · simulated'
  if (ticket.payment === 'pending') return 'Payment unconfirmed'
  if (ticket.status === 'accepted') return 'Accepted · payment due'
  if (ticket.status === 'review') return 'Needs your review'
  if (ticket.status === 'running') return `Working · attempt ${ticket.attempt}`
  if (!mission.approved) return 'Awaiting plan approval'
  return ready(mission, ticket) ? 'Ready to start' : `Waiting for ticket ${ticket.dependsOn.join(', ')}`
}

function ticketActions(mission: Mission, ticket: Ticket): HTMLElement {
  const actions = element('div', '', 'actions')
  const add = (label: string, action: Action, secondary = false) =>
    actions.append(button(label, action, ticket.id, secondary))
  if (!mission.approved) return actions
  if (ticket.status === 'waiting' && ready(mission, ticket))
    add(ticket.attempt ? 'Retry simulated work' : 'Start simulated work', 'start')
  if (ticket.status === 'running') add('Submit example delivery', 'submit')
  if (ticket.status === 'review') {
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
  body.append(top, element('p', `${ticket.worker} · ${ticket.reward} demo credits · You review`, 'meta'))
  body.append(element('p', ticket.criteria))
  if (ticket.dependsOn.length)
    body.append(element('p', `Starts after ticket ${ticket.dependsOn.join(', ')} is accepted.`, 'dependency'))
  if (ticket.status === 'review' || ticket.status === 'accepted') body.append(element('blockquote', ticket.sample))
  if (ticket.payment === 'pending')
    body.append(
      element('p', 'The reply was lost. Check the original operation before sending anything again.', 'pending-note'),
    )
  body.append(ticketActions(mission, ticket))
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
  proof.append(element('summary', 'Simulated payment evidence'))
  proof.append(
    element(
      'p',
      `${view.simulatedReceipts.length} provider receipts. This separate ledger can contain a payment the coordinator has not confirmed yet.`,
    ),
  )
  for (const receipt of view.simulatedReceipts) {
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
  if (event.type === 'plan_created') return 'Atlas proposed a three-ticket plan. Waiting for your approval.'
  if (event.type === 'plan_approved') return 'Plan approved with a cap of 300 demo credits.'
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

function render(view: View, focusKey?: string): void {
  current = view
  const mission = view.mission
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
  for (const ticket of mission.tickets) section.append(ticketRow(mission, ticket))
  const layout = element('div', '', 'mission-layout')
  layout.append(section, summary(view))
  target('mission').replaceChildren(layout)
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
  if (focusKey) {
    const active = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-key]')).find(
      (b) => b.dataset.key === focusKey,
    )
    const fallback = document.getElementById(`ticket-${focusKey.split('-')[0] || '01'}`)
    ;(active ?? fallback)?.focus({ preventScroll: true })
  }
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
    render(await read(url, body), focusKey)
    target('feedback').textContent = message
  } catch (error) {
    target('feedback').textContent = error instanceof Error ? error.message : 'Could not read the preview.'
    if (current) render(current, focusKey)
  } finally {
    busy = false
    for (const node of document.querySelectorAll<HTMLButtonElement>('button')) node.disabled = false
  }
}

async function command(action: Action, ticketId: string): Promise<void> {
  if (!current) return
  const message =
    action === 'lose_reply'
      ? 'Reply lost. Reload from disk, then reconcile the pending payment.'
      : 'Step saved to the journal.'
  await update('/api/command', { id: crypto.randomUUID(), revision: current.revision, action, ticketId }, message)
}

target('recover').addEventListener('click', () => {
  void update('/api/recover', {}, 'Reopened the database and replayed the journal. No work was dispatched.')
})
target('refresh').addEventListener('click', () => {
  void update('/api/state', undefined, 'Showing the latest saved state.')
})
void update('/api/state', undefined, 'Try the plan. Every step is saved on this computer.')
