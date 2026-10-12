/** SDK-backed reads: every position and its backing are valued at the same block. */
import { publicKey } from './queries.ts'
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { data } from './api.ts'
import { type SidequestContracts, sidequest } from './sidequest.ts'
import { stakeContext } from './stake-context.ts'
import { deployed } from './wallet.ts'

export type Backing = Awaited<ReturnType<typeof sdk.getBacking>>
export type Position = Awaited<ReturnType<typeof sdk.getPosition>>
export interface BackedPosition {
  position: Position
  backing: Backing
}

type Wire<T> = T extends bigint ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T

type WirePosition = Wire<Position>
type WireBacking = Wire<Backing>

function parseBacking(backing: WireBacking): Backing {
  return {
    ...backing,
    blockNumber: BigInt(backing.blockNumber),
    assets: BigInt(backing.assets),
    reserved: BigInt(backing.reserved),
    shares: BigInt(backing.shares),
    queuedShares: BigInt(backing.queuedShares),
    generation: BigInt(backing.generation),
    active: BigInt(backing.active),
    queued: BigInt(backing.queued),
    available: BigInt(backing.available),
    tier: {
      ...backing.tier,
      threshold: BigInt(backing.tier.threshold),
      nextThreshold: backing.tier.nextThreshold === null ? null : BigInt(backing.tier.nextThreshold),
      needed: BigInt(backing.tier.needed),
    },
  }
}

function parsePosition(position: WirePosition): Position {
  return {
    ...position,
    blockNumber: BigInt(position.blockNumber),
    shares: BigInt(position.shares),
    activeShares: BigInt(position.activeShares),
    queuedShares: BigInt(position.queuedShares),
    value: BigInt(position.value),
    activeValue: BigInt(position.activeValue),
    queued: BigInt(position.queued),
    generation: BigInt(position.generation),
  }
}

async function readDelegations(contracts: SidequestContracts, delegator: Address) {
  const snapshot = await data<{
    source: 'index+vault'
    blockNumber: string
    token: Address
    vault: Address
    positions: Array<WirePosition & { backing: WireBacking }>
  }>(`delegations?wallet=${encodeURIComponent(delegator)}`)
  if (
    snapshot.vault.toLowerCase() !== contracts.vault.toLowerCase() ||
    snapshot.token.toLowerCase() !== contracts.factory.toLowerCase()
  ) {
    throw new Error('The backing index describes a different deployment. Refresh after the release.')
  }
  const blockNumber = BigInt(snapshot.blockNumber)
  const ctx = stakeContext(contracts)
  const [wallet, open, cooldown] = await Promise.all([
    ctx.publicClient.readContract({
      address: contracts.factory,
      abi: sdk.sideTokenAbi,
      functionName: 'balanceOf',
      args: [delegator],
      blockNumber,
    }),
    ctx.publicClient.readContract({
      address: contracts.vault,
      abi: sdk.stakeVaultAbi,
      functionName: 'bootstrapped',
      blockNumber,
    }),
    ctx.publicClient.readContract({
      address: contracts.vault,
      abi: sdk.stakeVaultAbi,
      functionName: 'UNSTAKE_DELAY',
      blockNumber,
    }),
  ])
  const positions = snapshot.positions.map((entry): BackedPosition => ({
    position: parsePosition(entry),
    backing: parseBacking(entry.backing),
  }))
  return {
    positions,
    wallet,
    open,
    cooldown: Number(cooldown),
    blockNumber,
    source: snapshot.source,
  }
}

export function useIndexedBacking(account: Address, wallet?: Address) {
  return useQuery({
    queryKey: publicKey('indexed-backing', sidequest.vault, account.toLowerCase(), wallet?.toLowerCase()),
    enabled: deployed,
    queryFn: async () => {
      const snapshot = await data<
        WireBacking & {
          source: 'index+vault'
          token: Address
          vault: Address
          delegatorCount: number
          topDelegators: WirePosition[]
          position: WirePosition | null
        }
      >(`backing/${account}${wallet === undefined ? '' : `?wallet=${encodeURIComponent(wallet)}`}`)
      if (
        snapshot.vault.toLowerCase() !== sidequest.vault.toLowerCase() ||
        snapshot.token.toLowerCase() !== sidequest.factory.toLowerCase()
      ) {
        throw new Error('The backing index describes a different deployment.')
      }
      return {
        backing: parseBacking(snapshot),
        position: snapshot.position === null ? null : parsePosition(snapshot.position),
        delegatorCount: snapshot.delegatorCount,
        topDelegators: snapshot.topDelegators.map(parsePosition),
      }
    },
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useDelegations(contracts: SidequestContracts, delegator: Address, enabled = true) {
  return useQuery({
    queryKey: publicKey('delegations', contracts.vault, delegator.toLowerCase()),
    queryFn: () => readDelegations(contracts, delegator),
    enabled,
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useBacking(account: Address | undefined, delegator?: Address) {
  return useQuery({
    queryKey: publicKey('backing', sidequest.vault, account?.toLowerCase(), delegator?.toLowerCase()),
    enabled: deployed && account !== undefined,
    queryFn: async () => {
      if (account === undefined) throw new Error('Choose a backing wallet')
      const ctx = stakeContext()
      const blockNumber = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
      const [backing, position] = await Promise.all([
        sdk.getBacking(ctx, account, { blockNumber }),
        delegator === undefined ? null : sdk.getPosition(ctx, account, delegator, { blockNumber }),
      ])
      return { backing, position }
    },
    refetchInterval: 15_000,
    retry: false,
  })
}
