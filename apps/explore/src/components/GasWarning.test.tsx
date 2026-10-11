import { renderToStaticMarkup } from 'react-dom/server'
import { parseEther } from 'viem'
import { expect, it } from 'vitest'
import { GasWarning, SWAP_GAS } from './GasWarning.tsx'

// Jonas's fresh email wallet tried Buy SIDE with no MON (dev, 11 Oct); the faucet's one-time 0.05 MON is not enough.
it('warns before a swap the wallet cannot pay gas for, and stays quiet when it can', () => {
  expect(SWAP_GAS).toBeGreaterThan(parseEther('0.05'))
  const short = renderToStaticMarkup(<GasWarning mon={0n} action="A swap" need={SWAP_GAS} />)
  expect(short).toContain('A swap is sent from your wallet')
  expect(short).toContain('needs about 0.09')
  expect(short).toContain('faucet.monad.xyz')
  expect(renderToStaticMarkup(<GasWarning mon={SWAP_GAS} action="A swap" need={SWAP_GAS} />)).toBe('')
  expect(renderToStaticMarkup(<GasWarning mon={undefined} />)).toBe('')
})
