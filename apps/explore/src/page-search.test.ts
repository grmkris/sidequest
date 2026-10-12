import { expect, it } from 'vitest'
import { searchWrite } from './page-search.ts'

it('writes a changed search in place', () => {
  expect(searchWrite({ pathname: '/jobs', search: '' }, '/jobs', '?tags=design')).toBe('/jobs?tags=design')
  expect(searchWrite({ pathname: '/jobs', search: '?tags=design' }, '/jobs', '')).toBe('/jobs')
})

it('never writes an unchanged search, nor over a pending navigation', () => {
  expect(searchWrite({ pathname: '/jobs', search: '?q=logo' }, '/jobs', '?q=logo')).toBeNull()
  // The router already left for /welcome; the browser URL still says /jobs until its microtask runs.
  expect(searchWrite({ pathname: '/jobs', search: '' }, '/welcome', '?tags=design')).toBeNull()
})
