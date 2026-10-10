import { readFileSync } from 'node:fs'
import { liveLaunchGate, type ChainConfig, type LaunchReader } from '../../apps/api/src/prod-config.ts'
import { RELAY_FLOOR_MAINNET } from '../../packages/sdk/src/relay.ts'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from '../../scripts/mining/viem.ts'

// Read-only: use the production D16 predicates unchanged. The G1e testnet core is fresh and its admin roles sit with
// the Safe (read on chain 10 Oct 2026), so no difference from production is expected any more. Policy is pinned
// independently of getOwners(); reading a policy from chain would be circular.
const config = JSON.parse(readFileSync(new URL('../config/monad-testnet.json', import.meta.url), 'utf8')) as ChainConfig
const policy = JSON.parse(readFileSync(new URL('./testnet-safe-policy.json', import.meta.url), 'utf8')) as {
  safe: string; owners: string[]; threshold: number
}
const rpc = process.env.MONAD_TESTNET_RPC_URL
if (!rpc) throw new Error('set MONAD_TESTNET_RPC_URL (never print its value)')
let id = 0
async function request(method: string, params: unknown[]): Promise<string> {
  // Public testnet RPC rate limits reads. Retry only reads, bound the retries,
  // and never print a provider body or URL (either can contain credentials).
  for (let attempt = 0; attempt < 3; attempt++) {
    await Bun.sleep(attempt === 0 ? 120 : 1_000 * attempt)
    try {
      const response = await fetch(rpc!, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000),
      })
      const body = await response.json() as { result?: unknown; error?: unknown }
      if (response.ok && body.error === undefined && typeof body.result === 'string' && /^0x[0-9a-fA-F]*$/.test(body.result)) {
        return body.result
      }
    } catch { /* fail closed after bounded read retries */ }
  }
  throw new Error('RPC read refused')
}

async function main() {
  if (config.network !== 'monad-testnet' || config.chainId !== 10143 || Number(await request('eth_chainId', [])) !== 10143) {
    throw new Error('testnet chain/config mismatch; refuses chain 143')
  }
  if (config.deployment.sidequest?.safe?.toLowerCase() !== policy.safe.toLowerCase()) throw new Error('Safe differs from the reviewed testnet policy')
  const block = await request('eth_blockNumber', [])
  const reader: LaunchReader = {
    code: to => request('eth_getCode', [to, block]),
    call: async (to, data) => await request('eth_call', [{ to, data }, block]) as `0x${string}`,
    balance: async to => BigInt(await request('eth_getBalance', [to, block])),
    storage: async (to, slot) => await request('eth_getStorageAt', [to, slot, block]) as `0x${string}`,
  }
  const failures = await liveLaunchGate(config, reader, RELAY_FLOOR_MAINNET, policy)
  const expected: string[] = []
  const unexpected = failures.filter(label => !expected.includes(label))
  const missing = expected.filter(label => !failures.includes(label))
  console.log(`D16 live testnet block ${BigInt(block)}; Safe ${policy.safe}; threshold ${policy.threshold}`)
  console.log(`Pinned owners: ${policy.owners.join(', ')}`)
  for (const label of failures) console.log(`${expected.includes(label) ? 'EXPECTED TESTNET DIFFERENCE' : 'FAIL'} ${label}`)
  for (const label of missing) console.log(`FAIL expected testnet difference changed: ${label}`)
  const abi = parseAbi(['function pendingOwner() view returns (address)', 'function epochEnd(uint256) view returns (uint256)'])
  const owned = [config.deployment.sidequest!.vault, config.deployment.sidequest!.feeSchedule, config.deployment.main!.holding,
    config.deployment.main!.evaluator, config.deployment.sidequest!.distributor, config.deployment.sidequest!.miningReserve]
  for (const to of owned) {
    const data = encodeFunctionData({ abi, functionName: 'pendingOwner' })
    const pending = decodeFunctionResult({ abi, functionName: 'pendingOwner', data: await reader.call(to!, data) })
    if (BigInt(pending) !== 0n) throw new Error('a handover remains pending')
  }
  const balance = await reader.balance(config.roles.relay!)
  console.log(`Configured relay ${config.roles.relay}: ${balance} wei; shared floor ${RELAY_FLOOR_MAINNET} wei`)
  console.log(`Configured attester ${config.roles.attester} (the gate tests this address, without overriding config)`)
  if (unexpected.length || missing.length) { process.exitCode = 1; return }
  console.log('PASS testnet parity: production D16 predicates hold with no differences; six pendingOwner values are zero')
  console.log('Production D16 remains unchanged and refuses these testnet role differences')
}

await main().catch(() => { console.error('D16 testnet parity refused: failed or malformed read/config'); process.exitCode = 1 })
