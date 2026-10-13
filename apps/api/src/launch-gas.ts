import { aaFromConfig, type DeploymentConfig } from '@sidequest/sdk'
import { accountAbstractionFailures } from './aa-preflight.ts'
import type { LaunchReader } from './prod-config.ts'

export interface LaunchAaProbe {
  readonly env: NodeJS.ProcessEnv
  readonly fetcher: typeof fetch
}

/** Read the configured AA contracts and ask Pimlico for the configured chain, EntryPoint and USDC paymaster. */
export async function launchAaFailures(
  config: Pick<DeploymentConfig, 'chainId' | 'accountAbstraction'> & { x402: { usdc: string } },
  reader: LaunchReader,
  probe: LaunchAaProbe,
): Promise<string[]> {
  let aa
  try {
    aa = aaFromConfig({
      chainId: config.chainId,
      ...(config.accountAbstraction === undefined ? {} : { accountAbstraction: config.accountAbstraction }),
    })
  } catch {
    return ['launch:accountAbstraction config invalid']
  }
  if (aa === null || aa.paymaster === null || aa.paymasterKind !== 'pimlico-erc20')
    return ['launch:mainnet USDC paymaster missing']
  if (aa.gasToken.toLowerCase() !== config.x402.usdc.toLowerCase()) return ['launch:gas token is not configured USDC']
  const failures: string[] = []
  for (const [name, address] of [
    ['EntryPoint', aa.entryPoint],
    ['paymaster', aa.paymaster],
    ['USDC', aa.gasToken],
  ] as const) {
    try {
      const code = await reader.code(address)
      if (!/^0x[0-9a-fA-F]+$/.test(code) || code === '0x') failures.push(`launch:${name} has no code`)
    } catch {
      failures.push(`launch:${name} code unreadable`)
    }
  }
  failures.push(
    ...(await accountAbstractionFailures({ ...probe, aa, chainId: config.chainId, reader })).map(
      (failure) => `launch:AA ${failure}`,
    ),
  )
  return failures
}
