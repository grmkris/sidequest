import { describe, expect, it } from 'vitest'
import { accountSearch, accountTab, legacyBackingDestination } from './account-route.ts'

describe('account route', () => {
  it('reads the tab, Wallet otherwise', () => {
    expect(accountTab('')).toBe('wallet')
    expect(accountTab('?tab=backing')).toBe('backing')
    expect(accountTab('?tab=notifications')).toBe('notifications')
    expect(accountTab('?tab=settings')).toBe('settings')
    expect(accountTab('?tab=nonsense')).toBe('wallet')
  })

  it('opens the tab an existing section anchor points at, unless the search names one', () => {
    expect(accountTab('', '#backing')).toBe('backing')
    expect(accountTab('', '#wallet')).toBe('wallet')
    expect(accountTab('', '#notifications')).toBe('notifications')
    expect(accountTab('', '#elsewhere')).toBe('wallet')
    expect(accountTab('?tab=settings', '#backing')).toBe('settings')
  })

  it('keeps other params and leaves the default tab out of the URL', () => {
    expect(accountSearch('?resume=t1', 'backing')).toBe('?resume=t1&tab=backing')
    expect(accountSearch('?tab=backing&resume=t1', 'wallet')).toBe('?resume=t1')
    expect(accountSearch('', 'wallet')).toBe('')
    expect(accountSearch('?tab=settings', 'notifications')).toBe('?tab=notifications')
  })

  it('maps bare and unsupported legacy context to the Backing tab', () => {
    for (const search of [
      '',
      '?agent=10401',
      '?tab=settings',
      '?next=https://evil.example',
      '?account=0x0',
      '?account=0x0000000000000000000000000000000000000000',
      '?account=0x0000000000000000000000000000000000000001&account=0x0000000000000000000000000000000000000002',
    ]) {
      expect(legacyBackingDestination(search)).toBe('/account?tab=backing')
    }
  })

  it('preserves a historical account address through the existing wallet/profile resolver', () => {
    expect(legacyBackingDestination('?account=0x0000000000000000000000000000000000000001')).toBe(
      '/wallet/0x0000000000000000000000000000000000000001',
    )
  })
})
