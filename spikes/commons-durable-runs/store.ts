import { Database } from 'bun:sqlite'
import { Conflict, decide, findTicket, paymentId, project, proposedMission } from './model.ts'
import type { Command, Entry, Event, Mission } from './model.ts'

export interface SimulatedReceipt {
  operationId: string
  worker: string
  amount: number
  receipt: string
}

/** Deliberately simulated provider, persisted separately from the coordinator's journal. */
export class SimulatedPayments {
  private db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.run(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS receipts (
        operationId TEXT PRIMARY KEY, worker TEXT NOT NULL, amount INTEGER NOT NULL, receipt TEXT NOT NULL
      )`)
  }
  lookup(operationId: string): SimulatedReceipt | null {
    return this.db.query<SimulatedReceipt, [string]>('SELECT * FROM receipts WHERE operationId = ?').get(operationId)
  }
  pay(operationId: string, ticket: { worker: string; reward: number }): SimulatedReceipt {
    return this.db
      .transaction(() => {
        const prior = this.lookup(operationId)
        if (prior) {
          if (prior.worker !== ticket.worker || prior.amount !== ticket.reward)
            throw new Conflict('Payment terms changed.')
          return prior
        }
        const receipt = `simulated-${crypto.randomUUID()}`
        this.db
          .query('INSERT INTO receipts VALUES (?, ?, ?, ?)')
          .run(operationId, ticket.worker, ticket.reward, receipt)
        return { operationId, worker: ticket.worker, amount: ticket.reward, receipt }
      })
      .immediate()
  }
  all(): SimulatedReceipt[] {
    return this.db.query<SimulatedReceipt, []>('SELECT * FROM receipts ORDER BY operationId').all()
  }
  close(): void {
    this.db.close()
  }
}

export interface Snapshot {
  revision: number
  mission: Mission
  journal: Entry[]
}

export class MissionStore {
  private db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.run(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, input TEXT NOT NULL)`)
    this.db
      .transaction(() => {
        if (!this.db.query('SELECT seq FROM journal LIMIT 1').get()) {
          this.append({ type: 'plan_created', mission: proposedMission(crypto.randomUUID()) })
        }
      })
      .immediate()
  }
  private append(event: Event): void {
    this.db.query('INSERT INTO journal (at, event) VALUES (?, ?)').run(new Date().toISOString(), JSON.stringify(event))
  }
  snapshot(): Snapshot {
    const rows = this.db
      .query<{ seq: number; at: string; event: string }, []>('SELECT * FROM journal ORDER BY seq')
      .all()
    const journal = rows.map((row): Entry => ({
      ...row,
      // SAFETY: this experiment trusts its local database, which receives Event values only through append.
      event: JSON.parse(row.event) as Event,
    }))
    return { revision: journal.length, mission: project(journal), journal }
  }
  /** Receipt and event commit together; stale independent writers cannot claim the same ticket. */
  command(command: Command): Snapshot {
    const input = JSON.stringify([command.revision, command.action, command.ticketId])
    this.db
      .transaction(() => {
        const prior = this.db
          .query<{ input: string }, [string]>('SELECT input FROM commands WHERE id = ?')
          .get(command.id)
        if (prior) {
          if (prior.input !== input) throw new Conflict('Command ID reused with different input.')
          return
        }
        const state = this.snapshot()
        if (command.revision !== state.revision)
          throw new Conflict('Another tab changed this mission. Refresh and try again.')
        const event = decide(state.mission, command)
        if (event) this.append(event)
        this.db.query('INSERT INTO commands VALUES (?, ?)').run(command.id, input)
      })
      .immediate()
    return this.snapshot()
  }
  /** The persisted intent is always present before we query or call the simulated provider. */
  settle(ticketId: string, provider: SimulatedPayments, loseReply = false): Snapshot {
    const { mission } = this.snapshot()
    const ticket = findTicket(mission, ticketId)
    if (ticket.payment === 'confirmed') return this.snapshot()
    if (ticket.payment !== 'pending') throw new Conflict('No persisted payment intent.')
    const operationId = paymentId(mission, ticket)
    const existing = provider.lookup(operationId)
    const receipt = existing ?? provider.pay(operationId, ticket)
    if (receipt.worker !== ticket.worker || receipt.amount !== ticket.reward)
      throw new Conflict('Receipt terms mismatch.')
    // Fault injection: the provider committed, but the coordinator never observes the acknowledgement.
    if (loseReply) return this.snapshot()
    this.db
      .transaction(() => {
        if (findTicket(this.snapshot().mission, ticketId).payment === 'confirmed') return
        this.append({
          type: 'payment_confirmed',
          ticketId,
          operationId,
          receipt: receipt.receipt,
          recovered: existing !== null,
        })
      })
      .immediate()
    return this.snapshot()
  }
  close(): void {
    this.db.close()
  }
}
