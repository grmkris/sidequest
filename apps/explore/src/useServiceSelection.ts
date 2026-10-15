import { useCallback, useState } from 'react'
import { selectionKey, toggleSelection } from './service-ask.ts'
import type { ServiceListing } from './services.ts'

/** Page-local picks keep their listing when search or paging changes. */
export function useServiceSelection() {
  const [listings, setListings] = useState<ServiceListing[]>([])
  const toggle = useCallback((listing: ServiceListing) => {
    setListings((current) => {
      const key = selectionKey(listing)
      const keys = toggleSelection(current.map(selectionKey), key)
      return keys.includes(key) ? [...current, listing] : current.filter((item) => selectionKey(item) !== key)
    })
  }, [])
  return {
    listings,
    toggle,
    selected: (listing: ServiceListing) => listings.some((item) => selectionKey(item) === selectionKey(listing)),
    clear: () => setListings([]),
  }
}
