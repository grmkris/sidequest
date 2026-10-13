import { expect, it } from 'vitest'
import { addressNode, remarkAddresses } from '../src/lib/remark-addresses.ts'
import { deployment } from '../../../packages/sdk/src/deployment.ts'
it('uses the SDK deployment configuration', () => {
  const d = deployment('monad-testnet')
  const text = JSON.stringify(addressNode('monad-testnet'))
  for (const value of [d.core, d.sidequest?.factory, d.stacks.main?.holding, d.stacks.main?.evaluator])
    expect(text).toContain(value)
})
it('shows the mainnet deployment from the SDK configuration (launched 13 Oct)', () => {
  const d = deployment('monad-mainnet')
  const text = JSON.stringify(addressNode('monad-mainnet'))
  for (const value of [d.core, d.sidequest?.factory, d.stacks.main?.holding, d.stacks.main?.evaluator])
    expect(text).toContain(value)
})
const tree = (network: string) =>
  ({
    type: 'root',
    children: [
      {
        type: 'mdxJsxFlowElement',
        name: 'ContractAddresses',
        attributes: [{ type: 'mdxJsxAttribute', name: 'network', value: network }],
        children: [],
      },
    ],
  }) as never
it('lets a page name the network, and refuses an unknown one', () => {
  const mainnet = tree('monad-mainnet')
  remarkAddresses()(mainnet)
  expect(JSON.stringify(mainnet)).toContain(deployment('monad-mainnet').core)
  expect(() => remarkAddresses()(tree('monad-devnet'))).toThrow('Unsupported ContractAddresses network')
})
