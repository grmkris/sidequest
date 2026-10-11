import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { type DeploymentConfig } from '../../packages/sdk/src/deployment.ts'
import { client } from './chain.ts'
import { CloudflareManifests, MiningPublishError, publishArgs, publishEpoch, stageOf } from './publish-lib.ts'

// Action/coordinator publication command: no deployment, state initialization, signer or on-chain transaction.
try {
  const args = publishArgs(process.argv.slice(2))
  const selected = stageOf(args.stage)
  const env = process.env
  if (
    (env.SIDEQUEST_STAGE && env.SIDEQUEST_STAGE !== selected.stage) ||
    (env.SIDEQUEST_NETWORK && env.SIDEQUEST_NETWORK !== selected.network)
  )
    throw new MiningPublishError('stage-chain-mismatch')
  const rpc = env.MONAD_RPC_URL
  if (!rpc || rpc === 'unset') throw new MiningPublishError('credentials-missing')
  const bytes = readFileSync(resolve(args.path))
  const publication = args.state === undefined ? bytes : { epoch: bytes, state: readFileSync(resolve(args.state)) }
  const config = JSON.parse(
    readFileSync(new URL(`../../contracts/config/${selected.network}.json`, import.meta.url), 'utf8'),
  ) as DeploymentConfig
  const c = client(rpc)
  await publishEpoch(
    publication,
    selected,
    config,
    {
      getChainId: () => c.getChainId(),
      readRoot: (address, epoch) =>
        c.readContract({ address, abi: epochDistributorAbi, functionName: 'rootOf', args: [epoch] }),
    },
    new CloudflareManifests(env),
  )
  console.log('mining:publish uploaded and verified')
} catch (error) {
  // RPC/provider exceptions can contain credentials and request bodies; print only our fixed codes.
  console.error(`mining:publish refused: ${error instanceof MiningPublishError ? error.code : 'unavailable'}`)
  process.exitCode = 1
}
