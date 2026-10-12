import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { deliveryQuery, previewUrl } from './delivery-preview.ts'

describe('previewUrl', () => {
  it('reads the public board unprefixed and a tenant board under its own prefix', () => {
    const hash = `0x${'AB'.repeat(32)}`
    expect(previewUrl('', '5fbcae7f56aa8e79', hash)).toBe(
      `/data/deliverables/5fbcae7f56aa8e79/0x${'ab'.repeat(32)}/preview`,
    )
    expect(previewUrl('/b/my-team', 'task 1', hash)).toBe(
      `/b/my-team/data/deliverables/task%201/0x${'ab'.repeat(32)}/preview`,
    )
  })
})

it('re-reads a temporary 404 after its stale window without changing the delivery key', async () => {
  vi.useFakeTimers()
  let reads = 0
  vi.stubGlobal('fetch', async () => {
    reads++
    return reads === 1
      ? new Response(null, { status: 404 })
      : Response.json({
          deliverable: { descriptor: { kind: 'url', url: 'https://delivery.example' }, check: null },
          preview: { source: 'manifest', type: 'site', title: 'Ready', summary: null, poster: null, media: null },
        })
  })
  const client = new QueryClient()
  const options = deliveryQuery({ boardId: 'public', taskId: 'task', hash: '0xAB' })
  try {
    expect(await client.query(options)).toBeNull()
    expect(await client.query(options)).toBeNull()
    expect(reads).toBe(1)
    vi.setSystemTime(Date.now() + 30_001)
    expect((await client.query(options))?.preview.title).toBe('Ready')
    expect(reads).toBe(2)
    expect(options.queryKey).toEqual(deliveryQuery({ boardId: 'public', taskId: 'task', hash: '0xab' }).queryKey)
  } finally {
    client.clear()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
