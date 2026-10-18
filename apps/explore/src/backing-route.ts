import { createRoute, redirect, type AnyRootRoute } from '@tanstack/react-router'
import { legacyBackingDestination } from './account-route.ts'

/** Old bookmarks replace their entry; current Account/profile pages still own all backing actions. */
export const createBackingRoute = (root: AnyRootRoute) =>
  createRoute({
    getParentRoute: () => root,
    path: '/backing',
    beforeLoad: ({ location }) => {
      throw redirect({ href: legacyBackingDestination(location.searchStr), replace: true })
    },
  })
