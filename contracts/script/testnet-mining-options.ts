import { reserveAbi } from '../../scripts/mining/chain.ts'
import { parseAbi, type Address, type PublicClient } from '../../scripts/mining/viem.ts'
import type { LogSource } from '../../scripts/mining/hypersync.ts'

function flagsOf(args: string[]) {
  const flags = new Map<string, string>()
  const known = ['--claim-key-env', '--owner-key-env', '--stage', '--epoch', '--logs']
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!name || !known.includes(name) || !value || value.startsWith('--') || flags.has(name)) throw new Error(usage())
    flags.set(name, value)
  }
  return flags
}
function stageOption(value: string | undefined): 'dev' | 'prod' | undefined {
  if (value === undefined || value === 'dev' || value === 'prod') return value
  throw new Error(usage())
}
function logsOption(value = 'hypersync'): LogSource {
  if (value === 'rpc' || value === 'hypersync') return value
  throw new Error(usage())
}
function envOption(value: string | undefined) {
  if (value === undefined || /^[A-Z][A-Z0-9_]*$/.test(value)) return value
  throw new Error(usage())
}
/** Explicit selection; never guess an earned epoch or reuse another epoch's directory. */
export function miningOptions(args: string[]) {
  const inputArg = args[0], outArg = args[1]
  if (!inputArg || !outArg || inputArg.startsWith('--') || outArg.startsWith('--')) throw new Error(usage())
  const flags = flagsOf(args), epochArg = flags.get('--epoch') ?? '0'
  if (!/^(0|[1-9][0-9]*)$/.test(epochArg)) throw new Error(usage())
  const epoch = BigInt(epochArg)
  if (epoch >= 2n ** 256n) throw new Error('epoch exceeds uint256')
  return {
    inputArg, outArg, epoch,
    claimKeyEnv: envOption(flags.get('--claim-key-env')),
    ownerKeyEnv: envOption(flags.get('--owner-key-env') ?? 'SAFE_OWNER_PRIVATE_KEY')!,
    stage: stageOption(flags.get('--stage')),
    logs: logsOption(flags.get('--logs')),
  }
}

export function usage() {
  return 'usage: bash contracts/script/mine-epoch0-testnet.sh <unsigned-prices.json> <output-dir> [--claim-key-env <ENV_NAME>] [--owner-key-env <ENV_NAME>] [--stage dev|prod] [--epoch <n>] [--logs rpc|hypersync]'
}

export async function validateOwner(
  client: Pick<PublicClient, 'readContract'>,
  safe: Address,
  owner: Address,
  policyOwners: readonly Address[],
) {
  const owners = await client.readContract({ address: safe, abi: parseAbi(['function getOwners() view returns (address[])']), functionName: 'getOwners' })
  const normalized = owner.toLowerCase()
  if (!policyOwners.some((candidate) => candidate.toLowerCase() === normalized)) throw new Error('key is not a reviewed Safe owner')
  if (!owners.some((candidate) => candidate.toLowerCase() === normalized)) throw new Error('key is not a current Safe owner')
}

export function requirePriceEpoch(input: unknown, epoch: bigint) {
  const value = input as { epoch?: unknown; message?: { epoch?: unknown } } | null
  if ((value?.message?.epoch ?? value?.epoch) !== epoch.toString()) throw new Error('prices must name the selected epoch')
}

export class EpochNotEnded extends Error {}

/** Before reading keys, signing or creating a journal: both heads must pass the deployed boundary. */
export async function requireEndedEpoch(client: Pick<PublicClient, 'readContract' | 'getBlock'>, reserve: Address, epoch: bigint) {
  const end = await client.readContract({ address: reserve, abi: reserveAbi, functionName: 'epochEnd', args: [epoch] })
  const [latest, finalized] = await Promise.all([client.getBlock(), client.getBlock({ blockTag: 'finalized' })])
  if (latest.timestamp < end || finalized.timestamp < end) throw new EpochNotEnded(`epoch ${epoch} not ended: cutoff ${end}; latest=${latest.timestamp} finalized=${finalized.timestamp}`)
}
