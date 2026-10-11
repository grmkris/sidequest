import { UserRejectedRequestError } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import { describe, expect, it } from 'vitest'
import { askedKey, isRefusal, silentSignable } from './sign-in.ts'

const address = '0x1111111111111111111111111111111111111111'
const message = (over: { domain?: string; address?: `0x${string}`; chainId?: number } = {}) =>
  createSiweMessage({
    domain: over.domain ?? 'dev.sidequest.exchange',
    address: over.address ?? address,
    chainId: over.chainId ?? 10143,
    nonce: 'f87460953d58fae792bd7b88',
    uri: 'https://dev.sidequest.exchange',
    version: '1',
    statement: 'Sign in to the sidequest board "public". This signature moves no funds.',
  })
const here = { address, host: 'dev.sidequest.exchange', chainId: 10143 }

describe('the automatic board sign-in', () => {
  it('signs without a prompt only a sign-in for this site, this wallet and this chain', () => {
    expect(silentSignable(message(), here)).toBe(true)
    expect(silentSignable(message(), { ...here, address: address.toUpperCase().replace('0X', '0x') })).toBe(true)
    expect(silentSignable(message({ domain: 'evil.example' }), here)).toBe(false)
    expect(silentSignable(message({ address: '0x2222222222222222222222222222222222222222' }), here)).toBe(false)
    expect(silentSignable(message({ chainId: 143 }), here)).toBe(false)
    expect(silentSignable('Transfer everything to 0xabc', here)).toBe(false)
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
