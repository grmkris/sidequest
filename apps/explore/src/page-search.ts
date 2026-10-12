/**
 * Pages keep their filters and tabs in the URL with a raw `history.replaceState`, so typing in a filter neither
 * re-renders the route nor resets the scroll. That write must never land while a navigation is pending: TanStack's
 * history (1.162) updates its own location at once and writes the browser URL a microtask later, and a raw write in
 * between makes the router reload the old page while the address bar then shows the new one. That is how a new
 * account's /welcome kept showing Activity.
 */
import { useRouter } from '@tanstack/react-router'

/**
 * The URL to write for a page's new search (`''` or `?…`), or null when nothing changed or the router is already on
 * its way to another path.
 */
export function searchWrite(
  current: { readonly pathname: string; readonly search: string },
  routerPathname: string,
  search: string,
): string | null {
  if (routerPathname !== current.pathname || search === current.search) return null
  return `${current.pathname}${search}`
}

/** Writes a page's search into the URL in place, unless a navigation is pending or it is already there. */
export function useReplaceSearch(): (search: string) => void {
  const router = useRouter()
  return (search) => {
    const href = searchWrite(window.location, router.history.location.pathname, search)
    if (href !== null) window.history.replaceState(window.history.state, '', href)
  }
}
