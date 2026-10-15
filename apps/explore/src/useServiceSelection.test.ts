import { describe, expect, it } from 'vitest'
import { serviceListing } from './components/services/service-test-support.tsx'
import { loadPicks, savePicks, togglePick } from './useServiceSelection.ts'

/** A tab's sessionStorage, as far as the picks use it. */
function tabStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  }
}

const second = { ...serviceListing, serviceId: 'video', name: 'Explainer video' }

describe('picked services', () => {
  it('toggles picks in the order they were made', () => {
    const one = togglePick([], serviceListing)
    expect(one).toEqual([serviceListing])
    expect(togglePick(one, second)).toEqual([serviceListing, second])
    expect(togglePick([serviceListing, second], serviceListing)).toEqual([second])
    expect(togglePick([serviceListing], { ...serviceListing, agentId: '9' })).toHaveLength(2)
  })

  it('reads back what another page of the tab saved', () => {
    const storage = tabStorage()
    savePicks(storage, [serviceListing, second])
    expect(loadPicks(storage)).toEqual([serviceListing, second])
    savePicks(storage, [])
    expect(loadPicks(storage)).toEqual([])
  })

  it('reads unreadable or foreign storage as no picks, and keeps working when storage refuses', () => {
    expect(loadPicks(undefined)).toEqual([])
    expect(loadPicks(tabStorage({ 'sidequest.picked-services': '{not json' }))).toEqual([])
    expect(loadPicks(tabStorage({ 'sidequest.picked-services': '{"agentId":"1"}' }))).toEqual([])
    expect(
      loadPicks(tabStorage({ 'sidequest.picked-services': JSON.stringify([{ agentId: 1 }, serviceListing]) })),
    ).toEqual([serviceListing])
    const refusing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(loadPicks(refusing)).toEqual([])
    expect(() => savePicks(refusing, [serviceListing])).not.toThrow()
  })
})
