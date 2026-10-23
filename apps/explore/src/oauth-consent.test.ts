import { expect, it } from 'vitest'
import type { Address } from 'viem'
import type { Roles } from './commons.ts'
import { commonsRoleOffer, consentBody, mediaOffer } from './oauth-consent.ts'

const wallet: Address = '0xabcdef0000000000000000000000000000001234'
const other: Address = '0x0000000000000000000000000000000000005678'
const asked = ['sidequest:read', 'sidequest:work', 'sidequest:maintain']
const roles = (moderator: Address[], maintainer: Address[], enabled = true): Pick<Roles, 'enabled' | 'roles'> => ({
  enabled,
  roles: [
    { role: 'arbiter', holders: [wallet], source: 'deployment' },
    { role: 'moderator', holders: moderator, source: 'stage' },
    { role: 'maintainer', holders: maintainer, source: 'stage' },
  ],
})

// ADR-0028: the opt-in appears only when the client asked for the scope and the agent's wallet holds the role.
it('offers the Commons role tools as the role the chosen agent wallet holds, a maintainer before a moderator', () => {
  expect(commonsRoleOffer(asked, roles([], [`0x${wallet.slice(2).toUpperCase()}`]), wallet)).toBe('maintainer')
  expect(commonsRoleOffer(asked, roles([wallet], [wallet]), wallet)).toBe('maintainer')
  expect(commonsRoleOffer(asked, roles([wallet], [other]), wallet)).toBe('moderator')
})

it('offers nothing to a client that did not ask, a wallet without a role, or before the roles read answers', () => {
  expect(commonsRoleOffer(['sidequest:read', 'sidequest:work'], roles([], [wallet]), wallet)).toBeUndefined()
  expect(commonsRoleOffer(undefined, roles([], [wallet]), wallet)).toBeUndefined()
  // An arbiter is not offered the role tools; nor is an agent another wallet holds the role for.
  expect(commonsRoleOffer(asked, roles([other], [other]), wallet)).toBeUndefined()
  expect(commonsRoleOffer(asked, undefined, wallet)).toBeUndefined()
  expect(commonsRoleOffer(asked, roles([], [wallet], false), wallet)).toBeUndefined()
  expect(commonsRoleOffer(asked, roles([], [wallet]), null)).toBeUndefined()
  expect(commonsRoleOffer(asked, roles([], [wallet]), undefined)).toBeUndefined()
})

it('sends maintain: true only for an offered, ticked approval', () => {
  const base = { agentId: 'quill' }
  expect(consentBody({ ...base, approved: true, offer: 'maintainer', maintain: true })).toEqual({
    decision: 'approve',
    agentIds: ['quill'],
    maintain: true,
  })
  for (const body of [
    consentBody({ ...base, approved: true, offer: 'maintainer', maintain: false }),
    consentBody({ ...base, approved: true, offer: undefined, maintain: true }),
  ])
    expect(body).toEqual({ decision: 'approve', agentIds: ['quill'] })
  expect(consentBody({ ...base, approved: false, offer: 'moderator', maintain: true })).toEqual({
    decision: 'reject',
    agentIds: ['quill'],
  })
})

// ADR-0029: the media opt-in appears only when the client asked for sidequest:media and the server offers a role.
it('offers the media tools with the role the server answers, and sends media: true only when offered and ticked', () => {
  const media = ['sidequest:read', 'sidequest:media']
  expect(mediaOffer(media, 'operator')).toBe('operator')
  expect(mediaOffer(media, 'member')).toBe('member')
  for (const [scopes, offered] of [
    [media, null],
    [media, undefined],
    [media, 'owner'],
    [['sidequest:read'], 'operator'],
    [undefined, 'operator'],
  ] as const)
    expect(mediaOffer(scopes, offered)).toBeUndefined()
  const base = { agentId: 'reel', offer: undefined, maintain: false }
  expect(consentBody({ ...base, approved: true, mediaOffer: 'member', media: true })).toEqual({
    decision: 'approve',
    agentIds: ['reel'],
    media: true,
  })
  expect(consentBody({ ...base, approved: true, mediaOffer: undefined, media: true })).toEqual({
    decision: 'approve',
    agentIds: ['reel'],
  })
  expect(consentBody({ ...base, approved: false, mediaOffer: 'operator', media: true })).toEqual({
    decision: 'reject',
    agentIds: ['reel'],
  })
})
