import { erc20Abi } from 'viem'
/** Per-job economic assertions for the live harness, using its original reconciled terminal receipts. */
import { type Abi, type Address, type TransactionReceipt, decodeEventLog, zeroAddress } from 'viem'
import { coreAbi, sidequestHoldingAbi, stakeVaultAbi } from './abi/index.ts'

/** Legacy testnet vaults send slashed SIDE to this address. New vaults use their configured slashRecipient. */
export const SLASH_SINK: Address = '0x000000000000000000000000000000000000dEaD'

interface Event {
  name: string
  args: Record<string, unknown>
}
const eq = (a: unknown, b: Address) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const uint = (a: unknown) => BigInt(String(a))
const amount = (rows: readonly Event[], name: string, matches: (args: Event['args']) => boolean) =>
  rows
    .filter((e) => e.name === name && matches(e.args))
    .reduce((sum, e) => sum + uint(e.args.amount ?? e.args.value), 0n)
function exact(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) throw new Error(`${label}: got ${actual}, expected ${expected}`)
}
function events(receipts: readonly TransactionReceipt[], abi: Abi, address: Address): Event[] {
  const out: Event[] = []
  const seen = new Set<string>()
  for (const receipt of receipts) {
    if (receipt.status !== 'success' || seen.has(receipt.transactionHash))
      throw new Error('economic receipts must be successful and unique')
    seen.add(receipt.transactionHash)
    for (const log of receipt.logs) {
      if (!eq(log.address, address)) continue
      try {
        const e = decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true })
        if (e.eventName === undefined || e.args === undefined || Array.isArray(e.args)) continue
        out.push({ name: e.eventName, args: e.args as unknown as Record<string, unknown> })
      } catch {
        /* Other events from the same contract are not economic evidence. */
      }
    }
  }
  return out
}
export interface JobEconomics {
  jobId: bigint
  holding: Address
  core: Address
  vault: Address
  slashRecipient?: Address
  factory: Address
  token: Address
  creator: Address
  worker: Address
  creatorBond: bigint
  workerBond: bigint
  slashCreator: boolean
  slashWorker: boolean
  workerCredit: bigint
  workerOwed: bigint
}

function isSlashRecipient(to: unknown, recipient: Address | undefined): boolean {
  return eq(to, zeroAddress) || eq(to, SLASH_SINK) || (recipient !== undefined && eq(to, recipient))
}

/** Excludes setup, staking and withdrawal receipts; no current wallet total can replace this proof. */
export function verifyJobEconomics(receipts: readonly TransactionReceipt[], x: JobEconomics) {
  const holding = events(receipts, sidequestHoldingAbi, x.holding).filter(
    (e) => e.args.jobId !== undefined && uint(e.args.jobId) === x.jobId,
  )
  const vault = events(receipts, stakeVaultAbi, x.vault)
  for (const [side, account, bond, slash] of [
    [0, x.creator, x.creatorBond, x.slashCreator],
    [1, x.worker, x.workerBond, x.slashWorker],
  ] as const) {
    const match = (a: Event['args']) => Number(a.side) === side && eq(a.account, account)
    const vaultMatch = (a: Event['args']) => eq(a.holding, x.holding) && eq(a.account, account)
    exact(`side ${side} Holding release`, amount(holding, 'BondReleased', match), slash ? 0n : bond)
    exact(`side ${side} Holding slash`, amount(holding, 'BondSlashed', match), slash ? bond : 0n)
    exact(`side ${side} Vault release`, amount(vault, 'Released', vaultMatch), slash ? 0n : bond)
    exact(`side ${side} Vault slash`, amount(vault, 'Slashed', vaultMatch), slash ? bond : 0n)
  }
  const transfers = events(receipts, erc20Abi, x.factory)
  // New vaults send a slash to the configured recipient; old testnet vaults used zero or the dead address.
  exact(
    'SIDE slashed by Vault',
    amount(transfers, 'Transfer', (a) => eq(a.from, x.vault) && isSlashRecipient(a.to, x.slashRecipient)),
    (x.slashCreator ? x.creatorBond : 0n) + (x.slashWorker ? x.workerBond : 0n),
  )
  exact(
    'SIDE sent by Vault to an unapproved recipient',
    amount(transfers, 'Transfer', (a) => eq(a.from, x.vault) && !isSlashRecipient(a.to, x.slashRecipient)),
    0n,
  )
  const core = events(receipts, coreAbi, x.core).filter(
    (e) => e.args.jobId !== undefined && uint(e.args.jobId) === x.jobId,
  )
  exact(
    'worker reward entitlement',
    amount(core, 'PaymentReleased', (a) => eq(a.recipient, x.worker)) +
      amount(holding, 'RewardSettled', (a) => eq(a.to, x.worker) && Number(a.outcome) === 1),
    x.workerCredit,
  )
  exact(
    'worker deferred reward',
    amount(holding, 'PayoutOwed', (a) => eq(a.to, x.worker) && eq(a.token, x.token)),
    x.workerOwed,
  )
  exact(
    'worker reward transferred',
    amount(
      events(receipts, erc20Abi, x.token),
      'Transfer',
      (a) => eq(a.to, x.worker) && (eq(a.from, x.core) || eq(a.from, x.holding)),
    ),
    x.workerCredit - x.workerOwed,
  )
}

/** A withdrawal has no jobId: bind it to this scope's exact reconciled withdrawal receipt and token/account. */
export function verifyOwedWithdrawal(
  receipt: TransactionReceipt,
  holding: Address,
  token: Address,
  worker: Address,
  expected: bigint,
) {
  exact(
    'worker owed withdrawal',
    amount(
      events([receipt], sidequestHoldingAbi, holding),
      'OwedWithdrawn',
      (a) => eq(a.to, worker) && eq(a.token, token),
    ),
    expected,
  )
  exact(
    'worker owed reward transferred',
    amount(events([receipt], erc20Abi, token), 'Transfer', (a) => eq(a.from, holding) && eq(a.to, worker)),
    expected,
  )
}
