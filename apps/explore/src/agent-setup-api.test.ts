import { describe, expect, it } from 'vitest'
import { clientRedirect, handBack, proposalPoll } from './agent-setup-api.ts'

describe('clientRedirect', () => {
  it('follows an https client or a loopback one, and nothing else', () => {
    expect(clientRedirect('https://claude.ai/oauth/callback?code=x')).toBe('https://claude.ai/oauth/callback?code=x')
    expect(clientRedirect('http://127.0.0.1:8765/callback?code=x')).toBe('http://127.0.0.1:8765/callback?code=x')
    expect(clientRedirect('http://localhost:3000/cb')).toBe('http://localhost:3000/cb')
    expect(() => clientRedirect('http://evil.example/cb')).toThrow('redirect is unavailable')
    expect(() => clientRedirect('javascript:alert(1)')).toThrow('redirect is unavailable')
  })
})

describe('proposalPoll', () => {
  const proposal = { name: 'Quill', description: '', image: null }
  it('looks again while the avatar is drawn, for two minutes at most', () => {
    expect(proposalPoll(proposal, 1)).toBe(4_000)
    expect(proposalPoll(proposal, 30)).toBe(false)
    expect(proposalPoll({ ...proposal, image: '/avatars/a.png' }, 1)).toBe(false)
    expect(proposalPoll(null, 1)).toBe(false)
    expect(proposalPoll(undefined, 0)).toBe(false)
  })
})

describe('handBack', () => {
  it('names 127.0.0.1 only for a local client, and a hosted client by its host', () => {
    expect(handBack('http://127.0.0.1:8765/callback')).toEqual({ local: true, host: '127.0.0.1:8765' })
    expect(handBack('https://goblin.example/oauth/callback')).toEqual({ local: false, host: 'goblin.example' })
    expect(handBack('not a url')).toBeNull()
  })
})
