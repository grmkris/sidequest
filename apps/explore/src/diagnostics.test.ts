import { QueryClient } from '@tanstack/react-query'
import { expect, it } from 'vitest'
import { createDiagnostics } from './diagnostics.ts'

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let time = 10
  const diagnostics = createDiagnostics(client, {
    origin: 'https://explore.example',
    rpcOrigins: ['https://rpc.example'],
    pathname: () => '/b/private-tenant/wallet/private-wallet',
    now: () => time++,
  })
  return { client, diagnostics }
}

it('records query success and failure without retaining keys, results or error messages', async () => {
  const { client, diagnostics } = fixture()
  await client.query({ queryKey: ['boards', 'private-tenant'], queryFn: () => 'private-response' })
  await expect(
    client.query({ queryKey: ['private-key'], queryFn: () => Promise.reject(new Error('private-error')) }),
  ).rejects.toThrow()
  const snapshot = diagnostics.snapshot()
  expect(snapshot.entries.map((entry) => [entry.family, entry.route, entry.outcome])).toEqual([
    ['boards', 'wallet', 'success'],
    ['other', 'wallet', 'error'],
  ])
  expect(snapshot.entries.every((entry) => entry.durationMs > 0)).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain('private')
  diagnostics.stop()
  await client.query({ queryKey: ['job'], queryFn: () => 'done' })
  expect(diagnostics.snapshot().entries).toHaveLength(2)
  client.clear()
})

it('classifies resources, extracts only API duration and caps memory with copied snapshots', () => {
  const { client, diagnostics } = fixture()
  for (let i = 0; i < 201; i++)
    diagnostics.resource({
      name: 'https://explore.example/b/private-tenant/data/jobs?wallet=private-wallet',
      startTime: i,
      duration: 12.345,
      serverTiming: [{ name: 'api', duration: 8.25, description: 'private-description', toJSON: () => ({}) }],
    })
  const snapshot = diagnostics.snapshot()
  expect(snapshot.entries).toHaveLength(200)
  expect(snapshot.dropped).toBe(1)
  expect(snapshot.entries[0]).toMatchObject({ family: 'data/jobs', route: 'wallet', durationMs: 12.3, apiMs: 8.3 })
  expect(JSON.stringify(snapshot)).not.toContain('private')
  snapshot.entries[0]!.family = 'changed'
  expect(diagnostics.snapshot().entries[0]?.family).toBe('data/jobs')
  diagnostics.clear()
  for (const name of ['https://rpc.example/private-api-key', 'https://private.example/private-path'])
    diagnostics.resource({ name, startTime: 1, duration: 2, serverTiming: [] })
  expect(diagnostics.snapshot().entries.map((entry) => entry.family)).toEqual(['rpc', 'external'])
  diagnostics.stop()
  client.clear()
})
