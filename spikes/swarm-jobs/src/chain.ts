// In-memory stand-in for the v2 contracts on Monad: a job is a parent with seats, each seat a one-worker,
// one-judge escrow with its own bond, deadline and dispute path. Money and outcomes live only here; the
// relay never decides anything. `as` plays msg.sender.
import { type Address, type Hex, isAddressEqual } from 'viem'
import { type Reassign, type Roster, type Ruling, type Seat, type Submission, signer } from './typed'

export const FEE_BPS = 1000n // the 10% backing tier
export const REVIEW_WINDOW = 3600n
export const DISPUTE_WINDOW = 3600n
export const MIN_CREATOR_BOND = 1_000_000n * 10n ** 18n

export type SeatStatus =
  | 'offered'
  | 'active'
  | 'submitted'
  | 'rejected'
  | 'disputed'
  | 'paid'
  | 'failed'
  | 'slashed'
  | 'excused'
const TERMINAL: SeatStatus[] = ['paid', 'failed', 'slashed', 'excused']

export interface SeatState extends Seat {
  status: SeatStatus
  deliverableHash?: Hex
  submittedAt?: bigint
  rejectedAt?: bigint
  pastWorkers: Address[]
}

export interface Checkpoint {
  seat: number
  kind: 'submit' | 'accept' | 'reject'
  root: Hex
  count: number
  by: Address
  at: bigint
}

export interface Job {
  id: Hex
  creator: Address
  shapeHash: Hex
  swarmId: bigint
  arbitrator: Address
  activateBy: bigint
  creatorBond: bigint
  escrow: bigint
  status: 'open' | 'active' | 'closed'
  outcome?: 'completed' | 'failed'
  seats: SeatState[]
  checkpoints: Checkpoint[]
}

export interface Feedback {
  subject: 'agent' | 'swarm'
  id: bigint
  jobId: Hex
  seat: number
  value: 1 | -1
  tag: string
}

export class ChainError extends Error {}

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ChainError(message)
}

const same = (a: Address, b: Address) => isAddressEqual(a, b)

export class Monad {
  now = 1_760_000_000n
  readonly usdc = new Map<Address, bigint>()
  readonly stake = new Map<Address, { available: bigint; reserved: bigint }>()
  readonly slashed = new Map<Address, bigint>()
  readonly agents = new Map<bigint, Address>()
  readonly swarms = new Map<bigint, { name: string; owner: Address; members: bigint[] }>()
  readonly feedback: Feedback[] = []
  readonly jobs = new Map<Hex, Job>()
  readonly log: string[] = []
  private nextAgentId = 10_500n
  private nextSwarmId = 1n

  constructor(
    readonly treasury: Address,
    readonly slashRecipient: Address,
  ) {}

  advance(seconds: bigint | number) {
    this.now += BigInt(seconds)
  }

  // ---- tokens -------------------------------------------------------------------------------

  balance(account: Address) {
    return this.usdc.get(account) ?? 0n
  }

  mint(account: Address, amount: bigint) {
    this.usdc.set(account, this.balance(account) + amount)
  }

  private take(from: Address, amount: bigint) {
    need(this.balance(from) >= amount, 'insufficient USDC')
    this.usdc.set(from, this.balance(from) - amount)
  }

  stakeOf(account: Address) {
    return this.stake.get(account) ?? { available: 0n, reserved: 0n }
  }

  depositStake(account: Address, amount: bigint) {
    const s = this.stakeOf(account)
    this.stake.set(account, { ...s, available: s.available + amount })
  }

  private reserve(account: Address, amount: bigint) {
    const s = this.stakeOf(account)
    need(s.available >= amount, 'insufficient SIDE stake')
    this.stake.set(account, { available: s.available - amount, reserved: s.reserved + amount })
  }

  private release(account: Address, amount: bigint) {
    const s = this.stakeOf(account)
    this.stake.set(account, { available: s.available + amount, reserved: s.reserved - amount })
  }

  private burn(account: Address, amount: bigint) {
    const s = this.stakeOf(account)
    this.stake.set(account, { ...s, reserved: s.reserved - amount })
    this.slashed.set(this.slashRecipient, (this.slashed.get(this.slashRecipient) ?? 0n) + amount)
  }

  // ---- identity (ERC-8004 stand-in) ---------------------------------------------------------

  registerAgent(wallet: Address) {
    const id = this.nextAgentId++
    this.agents.set(id, wallet)
    return id
  }

  // A swarm is an identity of its own; its members are separate agents, possibly of different owners.
  registerSwarm(owner: Address, name: string, members: bigint[]) {
    for (const m of members) need(this.agents.has(m), `unknown agent ${m}`)
    const id = this.nextSwarmId++
    this.swarms.set(id, { name, owner, members })
    return id
  }

  // ---- reads --------------------------------------------------------------------------------

  job(jobId: Hex) {
    const job = this.jobs.get(jobId)
    need(job, 'unknown job')
    return job
  }

  judgeOf(job: Job, index: number) {
    const seat = job.seats[index]
    return seat.judgeSeat < 0 ? job.creator : job.seats[seat.judgeSeat].worker
  }

  participants(jobId: Hex) {
    const job = this.job(jobId)
    return [job.creator, job.arbitrator, ...job.seats.flatMap((s) => [s.worker, ...s.pastWorkers])]
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async openJob(roster: Roster, creatorSignature: Hex, creatorBond: bigint) {
    need(same(await signer('Roster', roster, creatorSignature), roster.creator), 'roster not signed by creator')
    need(!this.jobs.has(roster.jobId), 'job exists')
    need(creatorBond >= MIN_CREATOR_BOND, 'creator bond below floor')
    const n = roster.seats.length
    const swarm = roster.swarmId === 0n ? undefined : this.swarms.get(roster.swarmId)
    need(roster.swarmId === 0n || swarm, 'unknown swarm')
    roster.seats.forEach((seat, i) => {
      need(seat.index === i, 'seat index out of order')
      need(
        seat.dependsOn.every((d) => d >= 0 && d < n && d !== i),
        'bad dependency',
      )
      need(seat.judgeSeat === -1 || (seat.judgeSeat >= 0 && seat.judgeSeat < n && seat.judgeSeat !== i), 'bad judge')
      need(
        same(this.agents.get(seat.agentId) ?? '0x0000000000000000000000000000000000000000', seat.worker),
        "worker is not the agent's wallet",
      )
      need(
        !same(seat.worker, roster.creator) && !same(seat.worker, roster.arbitrator),
        'worker conflicts with creator or arbitrator',
      )
      need(!swarm || swarm.members.includes(seat.agentId), 'seat worker is not a swarm member')
    })
    const budget = roster.seats.reduce((sum, s) => sum + s.reward, 0n)
    this.take(roster.creator, budget)
    this.reserve(roster.creator, creatorBond)
    this.jobs.set(roster.jobId, {
      id: roster.jobId,
      creator: roster.creator,
      shapeHash: roster.shapeHash,
      swarmId: roster.swarmId,
      arbitrator: roster.arbitrator,
      activateBy: roster.activateBy,
      creatorBond,
      escrow: budget,
      status: 'open',
      seats: roster.seats.map((s) => ({ ...s, status: 'offered', pastWorkers: [] })),
      checkpoints: [],
    })
    this.log.push(`openJob ${roster.jobId.slice(0, 10)} · ${n} seats · escrow ${budget}`)
  }

  activateSeat(jobId: Hex, index: number, as: Address) {
    const job = this.job(jobId)
    const seat = job.seats[index]
    need(seat.status === 'offered', 'seat not offered')
    need(same(as, seat.worker), "only the seat's worker activates")
    need(this.now <= seat.deadline, 'seat deadline passed')
    this.reserve(seat.worker, seat.bond)
    seat.status = 'active'
    if (job.status === 'open' && job.seats.every((s) => !s.required || s.status !== 'offered')) job.status = 'active'
  }

  async submit(sub: Submission, signature: Hex, count: number) {
    const job = this.job(sub.jobId)
    const seat = job.seats[sub.seat]
    need(seat.status === 'active', 'seat not active')
    need(same(await signer('Submission', sub, signature), seat.worker), "submission not signed by the seat's worker")
    need(this.now <= seat.deadline, 'seat deadline passed')
    const unmet = seat.dependsOn.filter((d) => !['submitted', 'paid'].includes(job.seats[d].status))
    need(unmet.length === 0, `waiting on seats ${unmet.join(',')}`)
    seat.status = 'submitted'
    seat.deliverableHash = sub.deliverableHash
    seat.submittedAt = this.now
    this.checkpoint(job, sub.seat, 'submit', sub.transcriptRoot, count, seat.worker)
  }

  accept(jobId: Hex, index: number, root: Hex, count: number, as: Address) {
    const job = this.job(jobId)
    need(job.seats[index].status === 'submitted', 'seat not submitted')
    need(same(as, this.judgeOf(job, index)), "only the seat's judge accepts")
    this.checkpoint(job, index, 'accept', root, count, as)
    this.pay(job, index)
  }

  reject(jobId: Hex, index: number, root: Hex, count: number, as: Address) {
    const job = this.job(jobId)
    const seat = job.seats[index]
    need(seat.status === 'submitted', 'seat not submitted')
    need(same(as, this.judgeOf(job, index)), "only the seat's judge rejects")
    need(this.now <= (seat.submittedAt ?? 0n) + REVIEW_WINDOW, 'review window closed')
    this.checkpoint(job, index, 'reject', root, count, as)
    seat.status = 'rejected'
    seat.rejectedAt = this.now
  }

  // Silence after a timely submission is acceptance; anyone may call it.
  finalizeSilence(jobId: Hex, index: number) {
    const job = this.job(jobId)
    const seat = job.seats[index]
    need(seat.status === 'submitted', 'seat not submitted')
    need(this.now > (seat.submittedAt ?? 0n) + REVIEW_WINDOW, 'review window open')
    this.pay(job, index)
  }

  dispute(jobId: Hex, index: number, as: Address) {
    const seat = this.job(jobId).seats[index]
    need(seat.status === 'rejected', 'seat not rejected')
    need(same(as, seat.worker), 'only the worker disputes')
    need(this.now <= (seat.rejectedAt ?? 0n) + DISPUTE_WINDOW, 'dispute window closed')
    seat.status = 'disputed'
  }

  finalizeRejection(jobId: Hex, index: number) {
    const job = this.job(jobId)
    const seat = job.seats[index]
    need(seat.status === 'rejected', 'seat not rejected')
    need(this.now > (seat.rejectedAt ?? 0n) + DISPUTE_WINDOW, 'dispute window open')
    this.fail(job, index)
  }

  // A ruling must cite a transcript root the chain already holds for that seat.
  async applyRuling(ruling: Ruling, signature: Hex) {
    const job = this.job(ruling.jobId)
    need(job.seats[ruling.seat].status === 'disputed', 'seat not disputed')
    need(same(await signer('Ruling', ruling, signature), job.arbitrator), "ruling not signed by the job's arbitrator")
    need(
      job.checkpoints.some((c) => c.seat === ruling.seat && c.root === ruling.transcriptRoot),
      'ruling cites no recorded checkpoint',
    )
    if (ruling.workerWins) this.pay(job, ruling.seat)
    else this.fail(job, ruling.seat)
  }

  // A missed deadline needs no judgement: anyone may call this. A worker whose inputs never arrived is
  // excused (bond released, no rating); otherwise the no-show is slashed.
  expireSeat(jobId: Hex, index: number) {
    const job = this.job(jobId)
    const seat = job.seats[index]
    need(seat.status === 'active', 'seat not active')
    need(this.now > seat.deadline, 'deadline not passed')
    if (seat.dependsOn.some((d) => !['submitted', 'paid'].includes(job.seats[d].status))) {
      this.release(seat.worker, seat.bond)
      seat.status = 'excused'
      this.log.push(`excuse seat ${index} (${seat.role}): its inputs never arrived`)
      return
    }
    this.burn(seat.worker, seat.bond)
    seat.status = 'slashed'
    this.rate(job, index, -1)
    this.log.push(`slash no-show seat ${index} (${seat.role})`)
  }

  // The seat's judge (the creator, for a seat nobody took up) puts a new worker in a slashed, failed,
  // excused or untaken seat. The reward stays in escrow for the new worker.
  async reassign(r: Reassign, signature: Hex) {
    const job = this.job(r.jobId)
    const seat = job.seats[r.seat]
    const untaken = seat.status === 'offered' && this.now > job.activateBy
    need(['slashed', 'failed', 'excused'].includes(seat.status) || untaken, 'seat cannot be reassigned')
    const judge = untaken ? job.creator : this.judgeOf(job, r.seat)
    need(same(await signer('Reassign', r, signature), judge), "reassign not signed by the seat's judge")
    need(
      same(this.agents.get(r.agentId) ?? '0x0000000000000000000000000000000000000000', r.worker),
      "worker is not the agent's wallet",
    )
    need(!same(r.worker, job.creator) && !same(r.worker, job.arbitrator), 'worker conflicts with creator or arbitrator')
    seat.pastWorkers.push(seat.worker)
    Object.assign(seat, {
      worker: r.worker,
      agentId: r.agentId,
      deadline: r.deadline,
      status: 'offered',
      deliverableHash: undefined,
      submittedAt: undefined,
      rejectedAt: undefined,
    })
    this.log.push(`reassign seat ${r.seat} (${seat.role})`)
  }

  // Closes once every seat is settled. Unspent rewards go back to the creator; the outcome needs every
  // required seat paid, so a failed lead fails the job while its paid helpers keep their pay.
  closeJob(jobId: Hex) {
    const job = this.job(jobId)
    need(job.status !== 'closed', 'job closed')
    const settled = (s: SeatState) => TERMINAL.includes(s.status) || (s.status === 'offered' && this.now > s.deadline)
    need(job.seats.every(settled), 'seats still open')
    this.mint(job.creator, job.escrow)
    job.escrow = 0n
    this.release(job.creator, job.creatorBond)
    job.status = 'closed'
    job.outcome = job.seats.every((s) => !s.required || s.status === 'paid') ? 'completed' : 'failed'
    this.log.push(`closeJob ${job.outcome}`)
  }

  // ---- internals ----------------------------------------------------------------------------

  private checkpoint(job: Job, seat: number, kind: Checkpoint['kind'], root: Hex, count: number, by: Address) {
    job.checkpoints.push({ seat, kind, root, count, by, at: this.now })
  }

  private pay(job: Job, index: number) {
    const seat = job.seats[index]
    const fee = (seat.reward * FEE_BPS) / 10_000n
    job.escrow -= seat.reward
    this.mint(seat.worker, seat.reward - fee)
    this.mint(this.treasury, fee)
    this.release(seat.worker, seat.bond)
    seat.status = 'paid'
    this.rate(job, index, 1)
    this.log.push(`pay seat ${index} (${seat.role}) ${seat.reward - fee} + fee ${fee}`)
  }

  private fail(job: Job, index: number) {
    const seat = job.seats[index]
    this.burn(seat.worker, seat.bond)
    seat.status = 'failed'
    this.rate(job, index, -1)
    this.log.push(`fail seat ${index} (${seat.role})`)
  }

  private rate(job: Job, index: number, value: 1 | -1) {
    const seat = job.seats[index]
    this.feedback.push({ subject: 'agent', id: seat.agentId, jobId: job.id, seat: index, value, tag: seat.role })
    // A replacement from outside the swarm earns its own record, not the swarm's.
    if (job.swarmId !== 0n && this.swarms.get(job.swarmId)?.members.includes(seat.agentId))
      this.feedback.push({ subject: 'swarm', id: job.swarmId, jobId: job.id, seat: index, value, tag: seat.role })
  }
}
