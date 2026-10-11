import type { Hex } from './viem.ts'

export const unsetHash = `0x${'0'.repeat(64)}` as const
export type PipelineStatus =
  | 'waiting-prices'
  | 'pending'
  | 'empty'
  | 'funded'
  | 'rooted'
  | 'published'
  | 'abandoned'
  | `failed:${string}`
export interface PendingEpoch {
  root: Hex | null
  total: bigint
  dataHash: Hex
  signature: string
  previous: bigint | null
  leaves: number
  sha256: string
}
export interface PipelineRoot {
  root: Hex
  total: bigint
  claimed: bigint
  dataHash: Hex
}
export interface PipelineRead {
  epoch: bigint
  root: PipelineRoot
  ended: boolean
  fundingFinal: boolean
  funded: bigint
  laterFunded: boolean
  anchor: bigint | null
  signature?: string
  pending?: PendingEpoch
  published?: PendingEpoch
}
export interface PipelineEntry {
  epoch: bigint
  prices: boolean
  pending: boolean
  published: boolean
}
export interface PipelineRow {
  epoch: bigint | null
  status: PipelineStatus
  artifact?: PendingEpoch
  next: string
}
export interface PipelineAction {
  kind: 'publish' | 'compute'
  epoch: bigint
}
export interface PipelinePlan {
  actions: PipelineAction[]
  rows: PipelineRow[]
  failed: boolean
}

/** Ignore unrelated objects; bigint ordering keeps epoch 9 before epoch 10. */
export function pipelineInventory(keys: readonly string[]): PipelineEntry[] {
  const entries = new Map<bigint, PipelineEntry>()
  for (const key of keys) {
    const match = /^mining\/(prices|pending-epoch|epoch)-(0|[1-9]\d*)\.json$/.exec(key)
    if (match === null) continue
    const epoch = BigInt(match[2]!)
    const entry = entries.get(epoch) ?? { epoch, prices: false, pending: false, published: false }
    if (match[1] === 'prices') entry.prices = true
    if (match[1] === 'pending-epoch') entry.pending = true
    if (match[1] === 'epoch') entry.published = true
    entries.set(epoch, entry)
  }
  return [...entries.values()].toSorted((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0))
}
export const matchesRoot = (pending: PendingEpoch | undefined, root: PipelineRoot) =>
  pending !== undefined &&
  pending.root !== null &&
  pending.root.toLowerCase() === root.root.toLowerCase() &&
  pending.total === root.total &&
  pending.dataHash.toLowerCase() === root.dataHash.toLowerCase()
const rooted = (read: PipelineRead) => read.root.dataHash.toLowerCase() !== unsetHash
const stale = (read: PipelineRead) =>
  read.pending === undefined || read.pending.signature !== read.signature || read.pending.previous !== read.anchor
const waiting = (read: PipelineRead) => !read.ended || !read.fundingFinal
const waitReason = (read: PipelineRead) =>
  !read.ended ? 'Wait for the epoch to end at the finalized head.' : 'Wait for funding finality.'

function targetPlan(read: PipelineRead): { action?: PipelineAction; status: PipelineStatus; next: string } {
  if (rooted(read)) {
    if (!matchesRoot(read.pending, read.root))
      return { status: 'failed:root-mismatch', next: 'Review the pending file against rootOf before retrying.' }
    return { status: 'rooted', next: 'The Action will publish the verified epoch.' }
  }
  if (waiting(read)) return { status: read.funded > 0n ? 'funded' : 'pending', next: waitReason(read) }
  if (stale(read)) {
    if (read.laterFunded)
      return { status: 'abandoned', next: 'A later epoch is funded; upload prices for the next epoch.' }
    return {
      action: { kind: 'compute', epoch: read.epoch },
      status: read.funded > 0n ? 'funded' : 'pending',
      next: 'The Action will compute this epoch; then load it in /admin.',
    }
  }
  return {
    status: read.funded > 0n ? 'funded' : 'pending',
    next:
      read.funded > 0n
        ? 'Load the epoch in /admin and set its root.'
        : 'Load the epoch in /admin, fund it and set its root.',
  }
}
function baseRow(entry: PipelineEntry, read: PipelineRead): PipelineRow {
  const artifact = read.published ?? read.pending
  const fields = { epoch: entry.epoch, ...(artifact === undefined ? {} : { artifact }) }
  if (entry.published) return { ...fields, status: 'published', next: 'Claims are available in Collect.' }
  if (read.pending?.root === null) return { ...fields, status: 'empty', next: 'No funding or root is needed.' }
  return { ...fields, status: 'waiting-prices', next: 'Sign and upload prices in /admin.' }
}

function entryPlan(entry: PipelineEntry, read: PipelineRead, target: bigint | undefined) {
  const row = baseRow(entry, read)
  if (!entry.published && matchesRoot(read.pending, read.root))
    return {
      row: { ...row, status: 'rooted' as const, next: 'The Action will publish the verified epoch.' },
      action: { kind: 'publish' as const, epoch: entry.epoch },
    }
  if (entry.epoch === target) {
    const decision = targetPlan(read)
    return { row: { ...row, status: decision.status, next: decision.next }, action: decision.action }
  }
  if (entry.prices && !entry.published && read.pending?.root !== null)
    return { row: { ...row, status: 'abandoned' as const, next: 'Superseded by the highest epoch with prices.' } }
  return { row }
}

/** Publication always precedes computation, so a newly published anchor can serve the target replay. */
export function planPipeline(keys: readonly string[], reads: readonly PipelineRead[]): PipelinePlan {
  const entries = pipelineInventory(keys),
    byEpoch = new Map(reads.map((read) => [read.epoch, read]))
  const candidates = entries.filter(
    (entry) => entry.prices && !entry.published && byEpoch.get(entry.epoch)?.pending?.root !== null,
  )
  const target = candidates.at(-1)?.epoch
  const actions: PipelineAction[] = [],
    rows: PipelineRow[] = []
  for (const entry of entries) {
    const read = byEpoch.get(entry.epoch)
    if (read === undefined) throw new Error('missing pipeline snapshot')
    const decision = entryPlan(entry, read, target)
    if (decision.action !== undefined) actions.push(decision.action)
    rows.push(decision.row)
  }
  if (!entries.some((entry) => entry.prices))
    rows.push({ epoch: null, status: 'waiting-prices', next: 'Sign and upload prices in /admin.' })
  return {
    actions: [
      ...actions.filter((action) => action.kind === 'publish'),
      ...actions.filter((action) => action.kind === 'compute'),
    ],
    rows,
    failed: rows.some((row) => row.status.startsWith('failed:')),
  }
}
