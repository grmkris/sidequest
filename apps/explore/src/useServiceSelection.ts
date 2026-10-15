import { useSyncExternalStore } from 'react'
import { selectionKey } from './service-ask.ts'
import type { ServiceListing } from './services.ts'

/**
 * The services a visitor picked, shared by every page in this tab: a pick made on the landing is still there on
 * Services or an agent's page, and survives a reload of the tab, never another tab or a later visit (sessionStorage).
 * Each pick keeps the listing it was made from, so search or paging never drops it.
 */
const STORAGE_KEY = 'sidequest.picked-services'
const EMPTY: ServiceListing[] = []

type PickStorage = Pick<Storage, 'getItem' | 'setItem'>

const isPick = (value: unknown): value is ServiceListing =>
  typeof value === 'object' &&
  value !== null &&
  'agentId' in value &&
  typeof value.agentId === 'string' &&
  'serviceId' in value &&
  typeof value.serviceId === 'string' &&
  'name' in value &&
  typeof value.name === 'string'

/** The stored picks; anything unreadable (another version's shape, a full or blocked storage) reads as none. */
export function loadPicks(storage: PickStorage | undefined): ServiceListing[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isPick) : []
  } catch {
    return []
  }
}

export function savePicks(storage: PickStorage | undefined, picks: readonly ServiceListing[]): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(picks))
  } catch {
    // A blocked or full storage keeps the picks for this page view only.
  }
}

/** Adds the listing, or takes it away when it is already picked; order is the order of picking. */
export function togglePick(picks: readonly ServiceListing[], listing: ServiceListing): ServiceListing[] {
  const key = selectionKey(listing)
  return picks.some((item) => selectionKey(item) === key)
    ? picks.filter((item) => selectionKey(item) !== key)
    : [...picks, listing]
}

const session = (): PickStorage | undefined => {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

const listeners = new Set<() => void>()
let current: ServiceListing[] | null = null

const snapshot = () => (current ??= loadPicks(session()))
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function publish(next: ServiceListing[]) {
  current = next
  savePicks(session(), next)
  for (const listener of listeners) listener()
}

export function useServiceSelection() {
  const listings = useSyncExternalStore(subscribe, snapshot, () => EMPTY)
  return {
    listings,
    toggle: (listing: ServiceListing) => publish(togglePick(snapshot(), listing)),
    selected: (listing: ServiceListing) => listings.some((item) => selectionKey(item) === selectionKey(listing)),
    clear: () => publish([]),
  }
}
