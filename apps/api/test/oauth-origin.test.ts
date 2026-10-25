import { expect, test } from 'vitest'
import { oauthOrigin, oauthHostRedirect } from '../src/oauth-origin.ts'

const canonical = 'https://dev.sidequest.exchange'
test('deployment pins issuer, resource and consent origin on hosted stages', () => {
  expect(oauthOrigin('https://alias.workers.dev', canonical)).toBe(canonical)
  expect(oauthOrigin('https://alias.workers.dev', 'https://sidequest.exchange')).toBe('https://sidequest.exchange')
  expect(oauthOrigin('http://localhost:8788', 'http://localhost:5173')).toBe('http://localhost:8788')
})

test('alternate hosts redirect to the canonical issuer without losing authorization query bytes', () => {
  expect(oauthHostRedirect(new URL('https://alias.workers.dev/oauth/authorize?state=a%2Fb&state=b'), canonical)).toBe(
    `${canonical}/oauth/authorize?state=a%2Fb&state=b`,
  )
  expect(oauthHostRedirect(new URL(`${canonical}/oauth/authorize`), canonical)).toBeUndefined()
  expect(oauthHostRedirect(new URL('http://localhost:8788/oauth/token'), 'http://localhost:5173')).toBeUndefined()
  // HTTPS enforcement on the service's own zone belongs to the edge, not this host canonicalizer.
  expect(oauthHostRedirect(new URL('http://dev.sidequest.exchange/oauth/token'), canonical)).toBeUndefined()
})
