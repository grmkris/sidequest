import { QueryClient } from '@tanstack/react-query'
import { expect, it } from 'vitest'
import { boardKey, directoryFirstQuery, managedKey, publicKey } from './queries.ts'
import { refreshJob } from './query-refresh.ts'

it('isolates tenant and viewer data while retaining separate directory response shapes', () => {
  const client = new QueryClient()
  client.setQueryData(boardKey('one', 'get_task', 'one', 'task'), { title: 'One' })
  expect(client.getQueryData(boardKey('two', 'get_task', 'two', 'task'))).toBeUndefined()
  client.setQueryData(managedKey('proposal', '0xAa', true, 'agent'), { private: true })
  expect(client.getQueryData(managedKey('proposal', '0xaa', true, 'agent'))).toEqual({ private: true })
  expect(client.getQueryData(managedKey('proposal', '0xbb', true, 'agent'))).toBeUndefined()
  expect(client.getQueryData(managedKey('proposal', '0xaa', false, 'agent'))).toBeUndefined()
  client.setQueryData(directoryFirstQuery().queryKey, {
    agents: [],
    nextCursor: null,
    observedAt: 0,
    chainId: 1,
    identityRegistry: '',
    scope: '',
  })
  expect(client.getQueryData(publicKey('data-directory'))).toBeUndefined()
})

it('refreshes a changed task and affected lists while leaving unrelated detail and directory data warm', async () => {
  const client = new QueryClient()
  const changed = boardKey('one', 'get_task', 'one', 'task-a')
  const unrelated = boardKey('one', 'get_task', 'one', 'task-b')
  const directory = publicKey('data-directory')
  const list = boardKey('one', 'chain-jobs', 'one')
  for (const key of [changed, unrelated, directory, list]) client.setQueryData(key, {})
  await refreshJob(client, { boardId: 'one', taskId: 'task-a', jobId: '7' })
  expect(client.getQueryState(changed)?.isInvalidated).toBe(true)
  expect(client.getQueryState(list)?.isInvalidated).toBe(true)
  expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false)
  expect(client.getQueryState(directory)?.isInvalidated).toBe(false)
})
