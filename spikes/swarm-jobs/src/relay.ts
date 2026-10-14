// A Sidequest relay: plain Nostr storage plus three rules read from the chain, never written to it.
// 1. A link is accepted only if the wallet signed it and the registry agrees.
// 2. A job channel is readable and writable only by that job's on-chain participants.
// 3. A panel reveal is refused until every peer of the author has committed on-chain.
import { type NostrEvent, verifyEvent } from 'nostr-tools/pure'
import { type Address, type Hex, concat, isAddressEqual, keccak256, recoverMessageAddress, zeroHash } from 'viem'
import { KIND, linkMessage } from './actors'
import type { Checkpoint, Monad } from './chain'

export class RelayError extends Error {}
export class RelayDown extends RelayError {}

const tag = (e: NostrEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1]

export class Relay {
  down = false
  private readonly stored: NostrEvent[] = []
  private readonly links = new Map<string, { wallet: Address; agentId: bigint }>()

  constructor(private readonly chain: Monad) {}

  walletOf(nostrPk: string) {
    return this.links.get(nostrPk)?.wallet
  }

  async publish(event: NostrEvent) {
    if (this.down) throw new RelayDown('relay unreachable')
    if (!verifyEvent(event)) throw new RelayError('bad event signature')
    if (event.kind === KIND.LINK) await this.acceptLink(event)
    else if (event.kind === KIND.REQUEST) this.requireLinked(event)
    else if (event.kind === KIND.CHANNEL) this.acceptChannel(event)
    else if (event.kind !== 1059) throw new RelayError(`kind ${event.kind} not served`)
    this.stored.push(event)
  }

  requests() {
    this.up()
    return this.stored.filter((e) => e.kind === KIND.REQUEST)
  }

  // Gift wraps hide their sender from the relay; only the recipient learns who sent them.
  giftWrapsFor(nostrPk: string) {
    this.up()
    return this.stored.filter((e) => e.kind === 1059 && tag(e, 'p') === nostrPk)
  }

  channel(jobId: Hex, readerPk: string) {
    this.up()
    this.requireParticipant(jobId, readerPk)
    return this.stored.filter((e) => e.kind === KIND.CHANNEL && tag(e, 'job') === jobId)
  }

  private up() {
    if (this.down) throw new RelayDown('relay unreachable')
  }

  private async acceptLink(e: NostrEvent) {
    const { agentId, wallet, evmSig } = JSON.parse(e.content) as { agentId: string; wallet: Address; evmSig: Hex }
    const id = BigInt(agentId)
    const recovered = await recoverMessageAddress({ message: linkMessage(e.pubkey, id), signature: evmSig })
    if (!isAddressEqual(recovered, wallet)) throw new RelayError('link not signed by the wallet')
    const registered = this.chain.agents.get(id)
    if (id !== 0n && (!registered || !isAddressEqual(registered, wallet)))
      throw new RelayError('wallet is not the registered agent wallet')
    this.links.set(e.pubkey, { wallet, agentId: id })
  }

  private requireLinked(e: NostrEvent) {
    if (!this.links.has(e.pubkey)) throw new RelayError('unlinked key')
  }

  private requireParticipant(jobId: Hex, nostrPk: string) {
    const wallet = this.walletOf(nostrPk)
    if (!wallet || !this.chain.participants(jobId).some((p) => isAddressEqual(p, wallet)))
      throw new RelayError('not a participant of this job')
  }

  private acceptChannel(e: NostrEvent) {
    const jobId = tag(e, 'job') as Hex | undefined
    if (!jobId) throw new RelayError('channel event without job tag')
    this.requireParticipant(jobId, e.pubkey)
    if (tag(e, 't') !== 'reveal') return
    const job = this.chain.job(jobId)
    const wallet = this.walletOf(e.pubkey) as Address
    const mine = job.seats.find((s) => isAddressEqual(s.worker, wallet))
    if (!mine) throw new RelayError("only a seat's worker reveals")
    const peers = job.seats.filter((s) => s.judgeSeat === mine.judgeSeat)
    if (peers.some((s) => !['submitted', 'paid'].includes(s.status)))
      throw new RelayError('reveal refused: a panel peer has not committed on-chain')
  }
}

// The transcript root is a hash chain over event ids in relay order. Any party can recompute it,
// and a checkpoint on-chain fixes both the root and how many events it covers.
export function transcriptRoot(events: NostrEvent[]) {
  let root: Hex = zeroHash
  for (const e of events) root = keccak256(concat([root, `0x${e.id}`]))
  return { root, count: events.length }
}

// What an arbitrator checks: every event is signed, belongs to the job, and the first `count`
// events hash to the root the chain recorded. Dropping or inventing a message breaks the root.
export function verifyTranscript(events: NostrEvent[], jobId: Hex, checkpoint: Checkpoint) {
  if (events.length < checkpoint.count) return false
  const prefix = events.slice(0, checkpoint.count)
  if (!prefix.every((e) => verifyEvent(e) && tag(e, 'job') === jobId)) return false
  return transcriptRoot(prefix).root === checkpoint.root
}
