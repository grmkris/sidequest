import { expect, it } from 'vitest'
import record from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import { deploymentFromConfig, type DeploymentConfig } from './deployment.ts'

// SAFETY: this is the repository config used by deployment(), whose parser validates its fields.
const config = record as DeploymentConfig

it('reads AgentSweep only from config and remains null before deployment', () => {
  const { agentSweep: _sweep, ...undeployed } = config.deployment
  expect(deploymentFromConfig('monad-testnet', { ...config, deployment: undeployed }).agentSweep).toBeNull()
  const address = config.erc8004.identity
  const changed = { ...config, deployment: { ...config.deployment, agentSweep: address } }
  expect(deploymentFromConfig('monad-testnet', changed).agentSweep).toBe(address)
  expect(() =>
    deploymentFromConfig('monad-testnet', { ...changed, deployment: { ...changed.deployment, agentSweep: 'invalid' } }),
  ).toThrow('agentSweep')
})
