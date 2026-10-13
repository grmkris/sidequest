import { expect, test } from 'vitest'
import { hostedSendMode } from './hosted-send.ts'

test('mainnet defaults hosted agents to user operations and refuses relay mode', () => {
  expect(hostedSendMode('monad-mainnet', undefined)).toBe('userop')
  expect(hostedSendMode('monad-mainnet', 'userop')).toBe('userop')
  expect(() => hostedSendMode('monad-mainnet', 'relay')).toThrow('HOSTED_SEND=relay')
})

test('testnet preserves relay default and explicit user operations', () => {
  expect(hostedSendMode('monad-testnet', undefined)).toBe('relay')
  expect(hostedSendMode('monad-testnet', 'relay')).toBe('relay')
  expect(hostedSendMode('monad-testnet', 'userop')).toBe('userop')
})
