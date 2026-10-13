import { afterEach, expect, test } from 'vitest'
import { context, contextFor } from './client.ts'
import { deployment, setRelayOverride } from './deployment.ts'
import { buildGrant } from './delegation/grants.ts'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }

// Any testnet relay other than the configured one proves the override wins.
// SAFETY: config entries are 0x-prefixed addresses; setRelayOverride rejects anything else.
const [override] = testnet.roles.retiredRelays as `0x${string}`[]

afterEach(() => setRelayOverride(undefined))
test('stage relay override reaches deployment, every context factory and grant delegate', () => {
  setRelayOverride(override)
  const ctx = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  expect(deployment('monad-testnet').relay).toBe(override!.toLowerCase())
  expect(contextFor('monad-testnet', ctx.stack, 'http://127.0.0.1:1').deployment.relay).toBe(override!.toLowerCase())
  expect(
    buildGrant(ctx, { kind: 'operator', delegator: `0x${'1'.repeat(40)}`, salt: 1n, start: 1800000000 }).delegate,
  ).toBe(override!.toLowerCase())
})
