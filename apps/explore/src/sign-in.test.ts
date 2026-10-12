import { UserRejectedRequestError } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import { describe, expect, it } from 'vitest'
import { askedKey, isRefusal, silentSignable } from './sign-in.ts'

const address = '0x1111111111111111111111111111111111111111'
const now = Date.parse('2026-10-12T12:00:00Z')
const message = (
  over: { domain?: string; address?: `0x${string}`; chainId?: number; uri?: string; expiresIn?: number | null } = {},
) =>
  createSiweMessage({
    domain: over.domain ?? 'dev.sidequest.exchange',
    address: over.address ?? address,
    chainId: over.chainId ?? 10143,
    nonce: 'f87460953d58fae792bd7b88',
    uri: over.uri ?? 'https://dev.sidequest.exchange',
    version: '1',
    statement: 'Sign in to the sidequest board "public". This signature moves no funds.',
    ...(over.expiresIn === null ? {} : { expirationTime: new Date(now + (over.expiresIn ?? 10 * 60_000)) }),
  })
const here = { address, host: 'dev.sidequest.exchange', origin: 'https://dev.sidequest.exchange', chainId: 10143 }

describe('the automatic board sign-in', () => {
  it('signs without a prompt only a sign-in for this site, this wallet and this chain', () => {
    expect(silentSignable(message(), here, now)).toBe(true)
    expect(silentSignable(message(), { ...here, address: address.toUpperCase().replace('0X', '0x') }, now)).toBe(true)
    expect(silentSignable(message({ domain: 'evil.example' }), here, now)).toBe(false)
    expect(silentSignable(message({ address: '0x2222222222222222222222222222222222222222' }), here, now)).toBe(false)
    expect(silentSignable(message({ chainId: 143 }), here, now)).toBe(false)
    expect(silentSignable('Transfer everything to 0xabc', here, now)).toBe(false)
    // Another site's URI, no expiry, an expired one, or one valid far longer than the board's ten minutes.
    expect(silentSignable(message({ uri: 'https://evil.example/login' }), here, now)).toBe(false)
    expect(silentSignable(message({ expiresIn: null }), here, now)).toBe(false)
    expect(silentSignable(message({ expiresIn: -1000 }), here, now)).toBe(false)
    expect(silentSignable(message({ expiresIn: 24 * 3600_000 }), here, now)).toBe(false)
  })

  it('treats only the person saying no as a refusal', () => {
    expect(isRefusal(new UserRejectedRequestError(new Error('no')))).toBe(true)
    expect(isRefusal(new Error('User rejected the request.'))).toBe(true)
    expect(isRefusal(new Error('network unreachable'))).toBe(false)
    expect(isRefusal('rejected')).toBe(false)
  })

  it('remembers the automatic sign-in per address, whatever its case', () => {
    expect(askedKey('0xAbC')).toBe('sidequest.asked:0xabc')
  })
})
