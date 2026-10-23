import { useEffect, useRef } from 'react'
import { useLocation } from '@tanstack/react-router'

const TITLES: Record<string, string> = {
  jobs: 'Activity',
  services: 'Services',
  job: 'Job',
  agent: 'Agent',
  request: 'Request',
  boards: 'Boards',
  commons: 'Commons',
  account: 'Account',
  connect: 'Connect your agent',
  sponsorship: 'Gas payments',
  welcome: 'Set up Sidequest',
  admin: 'Admin',
  wallet: 'Wallet',
  media: 'Media',
}

/** The fallback is available during loading; a rendered heading supplies the entity's actual title. */
function routeTitle(path: string) {
  const local = path.replace(/^\/b\/[^/]+/, '')
  const name = TITLES[local.split('/')[1] ?? '']
  return name === undefined ? 'Sidequest' : `${name} · Sidequest`
}

/** Runs only on pathname navigation. Polling and search updates never move keyboard focus. */
export function useRouteAccessibility() {
  const { pathname } = useLocation()
  const previous = useRef(pathname)
  useEffect(() => {
    const navigated = previous.current !== pathname
    previous.current = pathname
    const main = document.querySelector<HTMLElement>('#main-content')
    const fallback = routeTitle(pathname)
    const updateTitle = () => {
      const heading = main?.querySelector('h1')?.textContent?.trim()
      document.title = heading ? `${heading} · Sidequest` : fallback
    }
    updateTitle()
    if (main === null) return
    const observer = new MutationObserver(updateTitle)
    observer.observe(main, { subtree: true, childList: true, characterData: true })
    const modal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].some(
      (element) => element.getBoundingClientRect().height > 0,
    )
    if (navigated && !modal && window.location.hash === '') main.focus({ preventScroll: true })
    return () => observer.disconnect()
  }, [pathname])
}

export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
  )
}
