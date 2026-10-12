/**
 * Where a link lands on the Commons page: the tab (`?tab=`, Lobby otherwise), the way Account keeps its tabs. Roadmap
 * items have their own page, `/commons/roadmap/<id>`.
 */
import { GAP_LABEL, type GapFilters, type GapStatus, type GapType } from './commons.ts'

const COMMONS_TABS = ['lobby', 'roadmap', 'gaps', 'roles'] as const
export type CommonsTab = (typeof COMMONS_TABS)[number]

const isTab = (value: string | null): value is CommonsTab => COMMONS_TABS.some((t) => t === value)

export function commonsTab(search: string): CommonsTab {
  const tab = new URLSearchParams(search).get('tab')
  return isTab(tab) ? tab : 'lobby'
}

/** The search string for a tab, keeping other params; Lobby, the default, needs none. */
export function commonsSearch(search: string, tab: CommonsTab): string {
  const params = new URLSearchParams(search)
  if (tab === 'lobby') params.delete('tab')
  else params.set('tab', tab)
  const s = params.toString()
  return s === '' ? '' : `?${s}`
}

/** Paths that belong to Commons, so the sidebar highlights it and not Jobs. */
export const onCommons = (path: string) => path === '/commons' || path.startsWith('/commons/')

/** Valid API filters from a shared URL; unrelated tab/search parameters are preserved by the writer. */
export function gapFilters(search: string): GapFilters {
  const p = new URLSearchParams(search)
  const status = p.get('gapStatus')
  const type = p.get('gapType')
  const tool = p.get('tool')
  // SAFETY: a type is included only after checking it is an own key of the complete gap-type label map.
  return {
    ...(status === 'open' || status === 'fixed' || status === 'wontfix' ? { status } : {}),
    ...(type !== null && Object.hasOwn(GAP_LABEL, type) ? { gapType: type as GapType } : {}),
    ...(tool !== null && /^[a-z][a-z0-9_]{1,63}$/.test(tool) ? { tool } : {}),
  }
}

export function gapSearch(
  search: string,
  filters: { status?: GapStatus | ''; gapType?: GapType | ''; tool?: string },
): string {
  const p = new URLSearchParams(commonsSearch(search, 'gaps'))
  for (const [key, value] of [
    ['gapStatus', filters.status],
    ['gapType', filters.gapType],
    ['tool', filters.tool?.trim()],
  ] as const) {
    if (value) p.set(key, value)
    else p.delete(key)
  }
  return `?${p.toString()}`
}
