/** Stage-derived role inputs and paths. This module never loads secrets or starts a process. */
import type { StageProfile } from '../../infra/stage.ts'

export type Role = 'arbiter' | 'moderator' | 'maintainer'
export type RoleInputs = Readonly<Record<string, string | undefined>>

export function roleLayout(repo: string, stage: StageProfile) {
  const mainnet = stage.network === 'monad-mainnet'
  const directory = `${repo}/.crew/roles${mainnet ? '/mainnet' : ''}`
  return {
    project: mainnet ? 'sidequest-roles-mainnet' : 'sidequest-roles',
    tree: `${repo}.wt/roles${mainnet ? '-mainnet' : ''}`,
    stateDir: `${directory}/state`,
    envDir: `${directory}/env`,
    composeFile: `${directory}/compose.json`,
    suffix: mainnet ? '-mainnet' : '',
  }
}

export function roleEnvironment(
  role: Role,
  inputs: RoleInputs,
  stage: StageProfile,
  modelBaseUrl: string,
  testnetBoards: readonly string[],
): Record<string, string | undefined> {
  if (stage.network === 'monad-mainnet' && role !== 'arbiter') throw new Error('Only arbiter is enabled on mainnet')
  const model = { ARBITER_MODEL_BASE_URL: modelBaseUrl, ARBITER_MODEL_API_KEY: inputs.CLIPROXY_API_KEY }
  if (role === 'arbiter') {
    const mainnet = stage.network === 'monad-mainnet'
    return {
      ...model,
      NETWORK: stage.network,
      BOARD_URLS: mainnet ? stage.origin : testnetBoards.join(','),
      ...(mainnet
        ? { SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: inputs.SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY }
        : { V1_ARBITRATOR_PRIVATE_KEY: inputs.SIDEQUEST_DEV_ARBITRATOR_PRIVATE_KEY }),
      // The documented default (.env.example); mainnet reads no .env.local, so it needs one here, as the moderator does.
      ARBITER_MODEL: inputs.ARBITER_MODEL || 'meta/muse-spark-1.3',
      ARBITER_RUNNER: mainnet ? 'sq-arbiter-mainnet@netcup' : 'sq-arbiter@netcup',
      ARBITER_INTERVAL_SECONDS: '60',
      // prod.env keeps prod-testnet's MONAD_RPC_URL beside MONAD_RPC_URL_MAINNET; explicitly mainnet names win.
      MONAD_RPC_URL: mainnet
        ? inputs.MONAD_MAINNET_RPC_URL || inputs.MONAD_RPC_URL_MAINNET || inputs.MONAD_RPC_URL
        : inputs.MONAD_RPC_URL || inputs.MONAD_TESTNET_RPC_URL,
      ARBITER_RULING_DIR: '/state/arbiter-rulings',
    }
  }
  if (role === 'moderator')
    return {
      NETWORK: stage.network,
      BOARD_URL: stage.origin,
      MODERATOR_PRIVATE_KEY: inputs.MODERATOR_PRIVATE_KEY,
      MODERATOR_MODEL: 'qwen3.8-flash',
      MODERATOR_MODEL_BASE_URL: modelBaseUrl,
      MODERATOR_MODEL_API_KEY: inputs.CLIPROXY_API_KEY,
      MODERATOR_CURSOR_FILE: '/state/moderator.cursor',
    }
  // Kimi reads the whole backlog in one pass (crew/MODELS.md). Moonshot's models aren't on the box's model gateway, so
  // the maintainer calls them through the Vercel AI Gateway, as Jev does.
  return {
    NETWORK: stage.network,
    BOARD_URL: stage.origin,
    MAINTAINER_PRIVATE_KEY: inputs.MAINTAINER_PRIVATE_KEY,
    MAINTAINER_MODEL: 'moonshotai/kimi-k3',
    MAINTAINER_MODEL_BASE_URL: AI_GATEWAY_URL,
    MAINTAINER_MODEL_API_KEY: inputs.AI_GATEWAY_API_KEY,
    MAINTAINER_STATE_FILE: '/state/maintainer.json',
  }
}

const AI_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1'
