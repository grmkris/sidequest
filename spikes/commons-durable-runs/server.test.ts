import { afterEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreview } from './server.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'commons-http-'))
  const preview = createPreview(directory)
  cleanup.push(() => {
    preview.close()
    rmSync(directory, { recursive: true })
  })
  const send = (body: object, origin = 'http://127.0.0.1:4318') =>
    preview.fetch(
      new Request('http://127.0.0.1:4318/api/command', {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify(body),
      }),
    )
  return { preview, send }
}

it('rejects cross-origin writes and rebinding hosts without changing the journal', async () => {
  const { preview, send } = fixture()
  expect(
    (await send({ id: 'a', revision: 1, action: 'approve', ticketId: '' }, 'https://unrelated.example')).status,
  ).toBe(403)
  expect((await preview.fetch(new Request('http://unrelated.example/api/state'))).status).toBe(403)
  const state = await preview.fetch(new Request('http://127.0.0.1:4318/api/state'))
  expect(await state.json()).toMatchObject({ revision: 1, mission: { approved: false } })
})

it('rejects malformed commands and stale writes with useful responses', async () => {
  const { send } = fixture()
  expect((await send({ action: 'approve' })).status).toBe(400)
  expect((await send({ id: 'a', revision: 1, action: 'approve', ticketId: '' })).status).toBe(200)
  expect((await send({ id: 'b', revision: 1, action: 'start', ticketId: '01' })).status).toBe(409)
})

it('reopens the database without executing a payment or appending an event', async () => {
  const { preview, send } = fixture()
  const approved = await send({ id: 'a', revision: 1, action: 'approve', ticketId: '' })
  const before = await approved.json()
  const recovered = await preview.fetch(
    new Request('http://127.0.0.1:4318/api/recover', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4318' },
    }),
  )
  expect(await recovered.json()).toEqual(before)
})
