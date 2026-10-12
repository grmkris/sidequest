import { hostname } from 'node:os'
import { ARBITER_PROMPT_VERSION, proposeRuling, type ModelEndpoint } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { arbitrateOnce } from './arbiter.ts'
import type { RoleClient } from './role.ts'
import { cancellationSender, rulingSender } from './runtime.ts'

export interface ArbiterRunOptions {
  readonly network: sdk.Network
  readonly endpoint: ModelEndpoint
  readonly env: NodeJS.ProcessEnv
  readonly log: (message: string) => void
}

export async function runArbiterPass(client: RoleClient, options: ArbiterRunOptions): Promise<boolean> {
  const { network, endpoint, env, log } = options
  const runner = env.ARBITER_RUNNER ?? `arbiter@${hostname()}`
  if (runner === '') throw new Error('ARBITER_RUNNER is not set')
  log(`signed in as ${client.account.address} (runner ${runner}, model ${endpoint.model})`)
  const rpcUrl = env.MONAD_RPC_URL ?? (network === 'monad-testnet' ? env.MONAD_TESTNET_RPC_URL : undefined)
  if (rpcUrl === undefined || rpcUrl === '') throw new Error('MONAD_RPC_URL is not set')
  const funded = rulingSender(network, client.account, rpcUrl, env.ARBITER_RULING_DIR)
  const result = await arbitrateOnce({
    sendRuling: funded.send,
    resumeRuling: (taskId) => funded.resume(taskId),
    board: client.board,
    account: client.account,
    network,
    runner,
    propose: (bundle, thread) => proposeRuling(endpoint, bundle, thread),
    log,
    model: endpoint.model,
    promptVersion: ARBITER_PROMPT_VERSION,
    sendCancellation: async (transaction) => {
      await cancellationSender(network, client.account, rpcUrl)(transaction)
    },
  })
  return result.outcomes.some((outcome) => outcome.result === 'skipped')
}
