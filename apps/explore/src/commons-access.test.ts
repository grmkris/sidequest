import { QueryClient } from '@tanstack/react-query'
import { createBoardApi } from '@sidequest/react'
import { afterEach, expect, it, vi } from 'vitest'
import { anonymousCommonsTool, forgetCommonsViewer } from './commons-access.ts'

afterEach(() => vi.unstubAllGlobals())

it('reads public and tenant Commons without inheriting the stored wallet session', async () => {
  const calls: { url: string; bearer: string | null }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, bearer: new Headers(init.headers).get('authorization') })
    return Response.json({ ok: true, result: { reports: [] } })
  })
  const session = new Map([['sidequest.session', 'test-previous-viewer']])
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  })
  await createBoardApi({ baseUrl: '' }).tool('list_gaps', { gapId: 6 })
  await anonymousCommonsTool('public', 'list_gaps', { gapId: 6 })
  await anonymousCommonsTool('test-board', 'list_gaps', { gapId: 6 })
  expect(calls).toEqual([
    { url: '/api/list_gaps', bearer: 'Bearer test-previous-viewer' },
    { url: '/api/list_gaps', bearer: null },
    { url: '/b/test-board/api/list_gaps', bearer: null },
  ])
})

it('forgets privileged content on identity changes and a late request cannot restore it', async () => {
  const client = new QueryClient()
  const oldKey = ['commons', 'gap', 6, 'previous-wallet']
  const publicKey = ['commons', 'gap', 6, '']
  const nextKey = ['commons', 'roles', 'next-wallet']
  client.setQueryData(oldKey, { userGoal: 'private goal' })
  client.setQueryData(publicKey, { reports: [] })
  client.setQueryData(nextKey, { viewer: 'next-wallet' })
  let finish!: (value: unknown) => void
  const pending = client
    .query({
      queryKey: ['commons', 'thread', 'lobby', 'previous-wallet'],
      queryFn: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    .catch(() => undefined)
  forgetCommonsViewer(client, 'previous-wallet')
  finish({ body: 'privileged hidden text' })
  await pending
  expect(client.getQueryData(oldKey)).toBeUndefined()
  expect(client.getQueryData(['commons', 'thread', 'lobby', 'previous-wallet'])).toBeUndefined()
  expect(client.getQueryData(publicKey)).toEqual({ reports: [] })
  expect(client.getQueryData(nextKey)).toEqual({ viewer: 'next-wallet' })
  client.clear()
})
