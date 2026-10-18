import { getAddress, isAddress } from 'viem'

/**
 * Where a link lands on the Account page: the tab (`?tab=`, Wallet otherwise). The section anchors other pages already
 * link to (`#wallet`, `#backing`, `#notifications`) open their tab too, and an explicit `?tab=` wins over them.
 */
const ACCOUNT_TABS = ['wallet', 'backing', 'notifications', 'settings'] as const
export type AccountTab = (typeof ACCOUNT_TABS)[number]

const isTab = (value: string | null): value is AccountTab => ACCOUNT_TABS.some((t) => t === value)

export function accountTab(search: string, hash = ''): AccountTab {
  const tab = new URLSearchParams(search).get('tab')
  if (isTab(tab)) return tab
  const anchor = hash.replace(/^#/, '')
  return isTab(anchor) ? anchor : 'wallet'
}

/** The search string for a tab, keeping other params (`?resume=`); Wallet, the default, needs none. */
export function accountSearch(search: string, tab: AccountTab): string {
  const params = new URLSearchParams(search)
  if (tab === 'wallet') params.delete('tab')
  else params.set('tab', tab)
  const s = params.toString()
  return s === '' ? '' : `?${s}`
}

/** Old /backing?account=<wallet> links lead to its existing public profile resolver. Unknown context is discarded. */
export function legacyBackingDestination(search: string): string {
  const accounts = new URLSearchParams(search).getAll('account')
  const account = accounts.length === 1 ? accounts[0] : undefined
  return account !== undefined && isAddress(account) && BigInt(account) !== 0n
    ? `/wallet/${getAddress(account)}`
    : '/account?tab=backing'
}
