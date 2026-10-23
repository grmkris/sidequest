import { expect, it } from 'vitest'
import { githubOidcPolicy, matchOidcPolicy, validateOidcPolicy } from './oidc-policy.ts'

const policy = githubOidcPolicy('acme/agent', 'main', 'https://sidequest.example/oauth/token', 'CI')
const claims = {
  iss: policy.issuer,
  aud: policy.claims.aud![0],
  sub: policy.claims.sub![0],
  repository: 'acme/agent',
  ref: 'refs/heads/main',
}

it('requires HTTPS and audience, and rejects malformed claim rules', () => {
  for (const invalid of [
    null,
    {},
    { ...policy, issuer: 'http://issuer.test' },
    { ...policy, issuer: 'https://user:pass@issuer.test' },
    { ...policy, claims: {} },
    { ...policy, claims: { aud: [] } },
    { ...policy, claims: { aud: [1] } },
    { ...policy, claims: { aud: ['aud'], constructor: ['x'] } },
  ])
    expect(validateOidcPolicy(invalid).length).toBeGreaterThan(0)
  expect(validateOidcPolicy(policy)).toEqual([])
})

it('matches every claim exactly, including exact issuer and subject', () => {
  expect(matchOidcPolicy(policy, claims)).toBe(true)
  for (const mismatch of [
    { iss: `${policy.issuer}/` },
    { sub: 'repo:acme/agent:pull_request' },
    { ref: 'refs/heads/other' },
    { repository: 'Acme/agent' },
    { aud: 'wrong' },
    { sub: undefined },
  ])
    expect(matchOidcPolicy(policy, { ...claims, ...mismatch })).toBe(false)
})

it('matches arrays on string intersection, never coerces numbers or accepts empty rules', () => {
  expect(matchOidcPolicy(policy, { ...claims, aud: ['other', claims.aud] })).toBe(true)
  expect(matchOidcPolicy({ issuer: policy.issuer, claims: { aud: ['1'] } }, { iss: policy.issuer, aud: [1] })).toBe(
    false,
  )
  expect(matchOidcPolicy({ issuer: policy.issuer, claims: {} }, claims)).toBe(false)
})
