export const mainnetProdSecretSources = {
  MONAD_RPC_URL: 'MONAD_RPC_URL',
  ATTESTER_PRIVATE_KEY: 'ATTESTER_PRIVATE_KEY',
  AI_GATEWAY_API_KEY: 'AI_GATEWAY_API_KEY',
  GITHUB_APP_PRIVATE_KEY: 'GITHUB_APP_PRIVATE_KEY',
  HYPERSYNC_API_TOKEN: 'HYPERSYNC_API_TOKEN',
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'TELEGRAM_WEBHOOK_SECRET',
  PRIVY_APP_SECRET: 'PRIVY_APP_SECRET',
  PRIVY_SIGNER_KEY: 'PRIVY_SIGNER_KEY',
  PIMLICO_API_KEY: 'PIMLICO_API_KEY',
} as const

/** Legacy testnet sources remain until the P8 relay deletion. */
export const prodSecretSources = { ...mainnetProdSecretSources, RELAY_PRIVATE_KEY: 'RELAY_PRIVATE_KEY' } as const

export function runtimeSecret(name: keyof typeof prodSecretSources): string | undefined {
  return process.env[name]
}
