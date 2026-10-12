import { readFileSync } from 'node:fs'
// By path: scripts/ is not a workspace package, so the bare '@sidequest/sdk' specifier does not resolve here.
import { RELAY_FLOOR_MAINNET } from '../packages/sdk/src/relay.ts'
import {
  liveLaunchGate,
  relayFloorWei,
  safePolicy,
  validateExploreRelease,
  validateProdConfig,
  type ProdArtifact,
} from '../apps/api/src/prod-config.ts'
import { probeRelease, rpcReader, sameOrigin } from '../apps/api/src/deploy-preflight.ts'
import { MAINNET_LIVE } from '../apps/explore/src/release.ts'
import mainnet from '../contracts/config/monad-mainnet.json' with { type: 'json' }

// bun scripts/preflight-prod.ts <artifact> [--live | --probe <origin>]
//   (none)            structural: the artifact against the mainnet config, and Explore's pinned MAINNET_LIVE against
//                     apps/explore/src/release.ts and the admission mode (PROD-GATE-006);
//   --live            then the D16 launch gate, read-only, through the artifact's RPC provider (MONAD_MAINNET_RPC_URL
//                     when that keyed URL is on the provider's origin);
//   --probe <origin>  after a deploy: <origin>/release.json must equal the artifact's network and mainnetLive.
const path = process.argv[2]
const live = process.argv.includes('--live')
const probeAt = process.argv.indexOf('--probe')
const origin = probeAt === -1 ? undefined : process.argv[probeAt + 1]
if (!path || (probeAt !== -1 && !origin))
  throw new Error(
    'pass a reviewed production artifact JSON path, optionally --live or --probe <origin>; no secret values',
  )
let artifact: ProdArtifact | undefined
let failures: string[]
try {
  artifact = JSON.parse(readFileSync(path, 'utf8')) as ProdArtifact
  failures = [...validateProdConfig(mainnet, artifact), ...validateExploreRelease(artifact, MAINNET_LIVE)]
} catch {
  console.error('production preflight rejected: artifact is unreadable or structurally invalid')
  process.exitCode = 1
  failures = []
}
if (failures.length > 0) {
  console.error(`production preflight rejected: ${failures.join(', ')}`)
  process.exitCode = 1
} else if (process.exitCode !== 1 && artifact !== undefined && origin !== undefined) {
  const probe = await probeRelease(artifact, origin)
  if (probe.length > 0) {
    console.error(`production release probe refused: ${probe.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(
      `Sidequest v1 production release probe passed: ${origin}/release.json serves monad-mainnet with mainnetLive ${artifact.explore.mainnetLive}, as pinned`,
    )
  }
} else if (process.exitCode !== 1 && !live) {
  console.log(
    'Sidequest v1 production structural preflight passed (single main pair, Safe, vault, fees and mining, Explore release flag); run with --live for the D16 launch gate',
  )
} else if (process.exitCode !== 1 && artifact !== undefined) {
  // D16 live launch gate, read-only, against the artifact's reviewed RPC provider. The artifact names it by origin; a
  // keyed URL on that provider (MONAD_MAINNET_RPC_URL, as the runbook's reads use) stays in the environment, unprinted.
  const keyed = process.env.MONAD_MAINNET_RPC_URL
  const rpcUrl = keyed !== undefined && sameOrigin(keyed, artifact.rpc.url) ? keyed : artifact.rpc.url
  const reader = rpcReader(rpcUrl)
  let gate: string[]
  try {
    const chain = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await chain.json()) as { result?: string }
    gate =
      Number(body.result) === 143
        ? await liveLaunchGate(mainnet, reader, relayFloorWei(RELAY_FLOOR_MAINNET), safePolicy(artifact))
        : ['launch:rpc is not chain 143']
  } catch {
    gate = ['launch:rpc unreadable']
  }
  if (gate.length > 0) {
    console.error(`production launch gate refused: ${gate.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(
      'Sidequest v1 production launch gate passed: the reviewed Safe (canonical 1.4.1, pinned owners and threshold, no module, no guard) owns all six, holds both core admin roles (deployer neither), attester verifies, relay above RELAY_FLOOR_MAINNET',
    )
  }
}
