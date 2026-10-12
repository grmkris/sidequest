import { boardsQuery } from './queries.ts'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { type Address, erc20Abi, isAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { type TokenMeta, registerTokens, subscribeTokens, tokenMeta, tokenRegistryVersion } from './format.ts'
import { chain } from './wallet.ts'

/** Loads every board's tokens (symbol and decimals as the board read them on-chain) into the amount formatter. */
export function useTokenRegistry(): void {
  const q = useQuery({
    ...boardsQuery(),
  })
  // Idempotent: a known address keeps its first entry.
  useEffect(() => {
    if (q.data !== undefined) registerTokens(q.data.boards.flatMap((board) => board.tokens))
  }, [q.data])
}

/**
 * Any ERC-20 by address (ADR-0010): its symbol and decimals, read from the chain the first time and added to the
 * formatter (as unverified unless the deployment lists it), so every amount in it reads right. `'reading'` until the
 * chain answers; `'none'` for text that is not an address, or an address that answers neither `symbol` nor `decimals`.
 */
export function useToken(address: string | null | undefined): TokenMeta | 'reading' | 'none' {
  useSyncExternalStore(subscribeTokens, tokenRegistryVersion, tokenRegistryVersion)
  const a = (address ?? '').trim().toLowerCase()
  const valid = isAddress(a, { strict: false })
  const known = valid ? tokenMeta(a) : undefined
  const token = a as Address
  const reads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: 'symbol', chainId: chain.id },
      { address: token, abi: erc20Abi, functionName: 'decimals', chainId: chain.id },
    ],
    query: { enabled: valid && known === undefined, staleTime: Infinity, retry: 1 },
  })
  useEffect(() => {
    const [symbol, decimals] = reads.data ?? []
    if (symbol?.status === 'success' && decimals?.status === 'success')
      registerTokens([{ address: a, symbol: symbol.result, decimals: decimals.result }])
  }, [a, reads.data])
  if (!valid) return 'none'
  if (known !== undefined) return known
  const [symbol, decimals] = reads.data ?? []
  if (symbol?.status === 'success' && decimals?.status === 'success') {
    return { symbol: symbol.result, decimals: decimals.result, unverified: true }
  }
  if (reads.isError) return 'none'
  return reads.isFetching || reads.data === undefined ? 'reading' : 'none'
}

export function useTokenList(addresses: readonly string[]): void {
  useSyncExternalStore(subscribeTokens, tokenRegistryVersion, tokenRegistryVersion)
  const unknown = [...new Set(addresses.map((address) => address.toLowerCase()))].filter(
    (address) => isAddress(address, { strict: false }) && tokenMeta(address) === undefined,
  )
  const reads = useReadContracts({
    contracts: unknown.flatMap(
      (address) =>
        [
          { address: address as Address, abi: erc20Abi, functionName: 'symbol', chainId: chain.id },
          { address: address as Address, abi: erc20Abi, functionName: 'decimals', chainId: chain.id },
        ] as const,
    ),
    query: { enabled: unknown.length > 0, staleTime: Infinity, retry: 1 },
  })
  const identity = unknown.join(',')
  useEffect(() => {
    const tokens = unknown.flatMap((address, index) => {
      const symbol = reads.data?.[index * 2]
      const decimals = reads.data?.[index * 2 + 1]
      return symbol?.status === 'success' &&
        typeof symbol.result === 'string' &&
        decimals?.status === 'success' &&
        typeof decimals.result === 'number'
        ? [{ address, symbol: symbol.result, decimals: decimals.result }]
        : []
    })
    registerTokens(tokens)
  }, [identity, reads.data])
}
