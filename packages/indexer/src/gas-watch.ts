import { errorDiagnostics } from '@sidequest/board'
import type { Deployment, Network } from '@sidequest/sdk'
import { ARBITER_LAUNCH_MON, ARBITER_ONE_RULING_MON } from '@sidequest/sdk'
import { type Address, formatEther } from 'viem'
import type { AsyncSql } from './store.ts'
import { enqueueWalletNotification, publicOrigin, telegramOwnerWallets } from './telegram.ts'

/**
 * The balances that pay gas once the relay is gone (ADR-0023): our testnet paymaster's EntryPoint deposit, which pays
 * the bundler for every USDC-charged user operation on testnet, and the arbitrator's MON, which sends its own rulings.
 * A ruling carries a 1.2M gas floor and Monad bills the limit, so one costs up to about 0.25 MON at 200 gwei.
 */
export const GAS_ALERTS = {
  paymaster: { warnWei: 5n * 10n ** 17n, criticalWei: 2n * 10n ** 17n },
  arbitrator: { warnWei: ARBITER_LAUNCH_MON, criticalWei: ARBITER_ONE_RULING_MON },
  repeatSeconds: 3600,
} as const

export type GasLevel = 'ok' | 'warning' | 'critical'

export interface GasWatch {
  readonly kind: 'paymaster' | 'arbitrator'
  readonly address: Address
  readonly read: () => Promise<bigint>
}

export interface GasWatchResult {
  readonly kind: GasWatch['kind']
  readonly level: GasLevel
  readonly balance: string
  readonly queued: boolean
}

export function gasLevel(kind: GasWatch['kind'], balance: bigint): GasLevel {
  const alert = GAS_ALERTS[kind]
  if (balance < alert.criticalWei) return 'critical'
  return balance < alert.warnWei ? 'warning' : 'ok'
}

const ENTRY_POINT_BALANCE = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

interface GasReader {
  getBalance(args: { address: Address }): Promise<bigint>
  readContract(args: {
    address: Address
    abi: typeof ENTRY_POINT_BALANCE
    functionName: 'balanceOf'
    args: readonly [Address]
  }): Promise<bigint>
}

/** What to watch on this deployment: the paymaster's deposit only where it is ours (testnet), the arbitrator always. */
export function gasWatches(deployment: Deployment, client: GasReader): GasWatch[] {
  const watches: GasWatch[] = [
    {
      kind: 'arbitrator',
      address: deployment.arbitrator,
      read: () => client.getBalance({ address: deployment.arbitrator }),
    },
  ]
  const aa = deployment.aa
  const paymaster = aa?.paymasterKind === 'sidequest-testnet' ? aa.paymaster : null
  if (aa !== null && paymaster !== null)
    watches.push({
      kind: 'paymaster',
      address: paymaster,
      read: () =>
        client.readContract({
          address: aa.entryPoint,
          abi: ENTRY_POINT_BALANCE,
          functionName: 'balanceOf',
          args: [paymaster],
        }),
    })
  return watches
}

const HINTS: Record<GasWatch['kind'], string> = {
  paymaster: "testnet user operations stop once the deposit can't cover one. Top it up with deposit() on the paymaster",
  arbitrator: 'the arbiter cannot send rulings without MON. Send it MON',
}

/**
 * Reads one balance and, below its warning level, queues an owner Telegram alert. The outbox id is per network, kind,
 * level, hour and wallet and the outbox ignores duplicates, so the minute cron sends at most one alert per level per
 * hour, with no state table of its own.
 */
export async function watchGas(
  sql: AsyncSql,
  input: { network: Network; now: number; watch: GasWatch },
): Promise<GasWatchResult> {
  const { kind, address } = input.watch
  const balance = await input.watch.read()
  const level = gasLevel(kind, balance)
  if (level === 'ok') return { kind, level, balance: balance.toString(), queued: false }
  const what = kind === 'paymaster' ? 'paymaster deposit' : 'arbitrator MON'
  const text =
    `<b>Sidequest ${what} ${level}</b> (${input.network}): ${Number(formatEther(balance)).toFixed(3)} MON at ${address}. ` +
    `${HINTS[kind]} (ADR-0023). ${publicOrigin()}`
  const id = `gas:${kind}:${input.network}:${level}:${Math.floor(input.now / GAS_ALERTS.repeatSeconds)}`
  for (const wallet of telegramOwnerWallets(input.network))
    await enqueueWalletNotification(sql, input.network, wallet, {
      id: `${id}:${wallet.toLowerCase()}`,
      text,
      now: input.now,
    })
  return { kind, level, balance: balance.toString(), queued: true }
}

/** A failed balance check never fails its caller; log bounded diagnostics only (no RPC URL, key or body). */
export function reportGasWatchFailure(error: unknown): void {
  console.error(JSON.stringify({ event: 'gas-watch-failed', ...errorDiagnostics(error) }))
}
