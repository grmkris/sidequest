/**
 * Builds the `Ctx` every action takes: a public client on the deployment's chain and one stack (Holding +
 * evaluator). The RPC URL is the caller's (from `.env.local` in scripts, a Worker binding in the API); never a
 * default baked into code.
 */
import { type Account, type Chain, createPublicClient, createWalletClient, http } from 'viem'
import { monad, monadTestnet } from 'viem/chains'
import type { Ctx, Wallet } from './actions.ts'
import { type Network, type Stack, type StackName, deployment, stack } from './deployment.ts'

export const chains: Record<Network, Chain> = { 'monad-testnet': monadTestnet, 'monad-mainnet': monad }

/**
 * Keeps one process under a public RPC's request limit (Monad testnet's answers `-32011 requests limited to
 * 15/sec`): requests leave at most `perSecond` a second, and a rate-limit answer is retried after a pause.
 */
export function throttledFetch(perSecond = 8, retries = 6): typeof fetch {
  let next = 0
  const gap = 1000 / perSecond
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const at = Math.max(Date.now(), next)
      next = at + gap
      if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()))
      const res = await fetch(input, init)
      if (attempt >= retries) return res
      const limited = res.status === 429 || (await res.clone().text()).includes('"code":-32011')
      if (!limited) return res
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
}

/** One limiter per process, shared by every client, since the limit is per caller, not per client. */
const sharedFetch = throttledFetch()
const transport = (rpcUrl: string) => http(rpcUrl, { fetchFn: sharedFetch })

/**
 * `batch` merges reads issued in the same tick into one multicall3 call. The board turns it on: a task summary is
 * several concurrent reads and a listing summarises many tasks at once.
 */
export function context(
  network: Network,
  stackName: StackName,
  rpcUrl: string,
  options: { readonly batch?: boolean } = {},
): Ctx {
  const d = deployment(network)
  return {
    publicClient: createPublicClient({
      chain: chains[network],
      transport: transport(rpcUrl),
      ...(options.batch === true ? { batch: { multicall: true } } : {}),
    }),
    deployment: d,
    stack: stack(d, stackName),
  }
}

/** A context for the configured pair found by its Holding (`stackByHolding`). */
export function contextFor(network: Network, s: Stack, rpcUrl: string): Ctx {
  return {
    publicClient: createPublicClient({ chain: chains[network], transport: transport(rpcUrl) }),
    deployment: deployment(network),
    stack: s,
  }
}

export function wallet(network: Network, account: Account, rpcUrl: string): Wallet {
  return createWalletClient({ account, chain: chains[network], transport: transport(rpcUrl) })
}
