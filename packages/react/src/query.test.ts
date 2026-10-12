import { expect, it } from 'vitest'
import { createBoardApi } from './client.ts'
import { boardQueryRoot, boardViewer } from './query.ts'

it('separates origins, chains and boards sharing the same QueryClient', () => {
  const a = createBoardApi({ baseUrl: 'https://one.example', boardId: 'team', storage: null })
  const b = createBoardApi({ baseUrl: 'https://two.example', boardId: 'team', storage: null })
  const c = createBoardApi({ baseUrl: 'https://one.example', boardId: 'other', storage: null })
  expect(boardQueryRoot(a, 1)).not.toEqual(boardQueryRoot(b, 1))
  expect(boardQueryRoot(a, 1)).not.toEqual(boardQueryRoot(a, 2))
  expect(boardQueryRoot(a, 1)).not.toEqual(boardQueryRoot(c, 1))
})

it('notifies private readers when credentials change without putting credentials in query identity', () => {
  const api = createBoardApi({ baseUrl: '', storage: null })
  const revisions: number[] = []
  const stop = api.subscribeSession(() => revisions.push(api.sessionRevision()))
  const before = boardViewer('0xAa', api.sessionRevision())
  api.setSession('private-token')
  const after = boardViewer('0xaa', api.sessionRevision())
  expect(after).not.toEqual(before)
  expect(JSON.stringify(after)).not.toContain('private-token')
  api.setSession('private-token')
  api.signOut()
  expect(revisions).toEqual([1, 2])
  stop()
})
