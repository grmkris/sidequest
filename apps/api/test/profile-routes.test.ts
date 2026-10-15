import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { AgentProfiles, AgentStore, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { profileReader } from '../src/profiles.ts'
import { isProfilePath, profileRoute } from '../src/routes/profiles.ts'
import { workersAiImages } from '../src/workers-ai-images.ts'

const deployment = sdk.deployment('monad-testnet')
const origin = 'https://dev.sidequest.exchange'
const avatar = `avatars/${'b'.repeat(64)}.jpg`
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** The management object's `managedProfiles`, as the Worker reaches it: JSON over RPC. */
function management() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const agents = new AgentStore(sql, () => 1000)
  agents.create({
    id: 'reel-key',
    operator: deployment.sidequest!.safe,
    privyUserId: 'did:privy:test',
    name: 'Reel',
    registry: deployment.identity,
    chainId: deployment.chainId,
  })
  agents.bindRegistry('reel-key', '2025')
  new AgentProfiles(sql, () => 1001).update('reel-key', { tagline: 'Explainers', avatarKey: avatar }, 'agent')
  const reader = profileReader(sql, () => 1001, deployment)
  return async (req: { agentKey?: string; agentId?: string }) =>
    JSON.stringify(
      req.agentKey === undefined ? await reader.profiles(req.agentId) : await reader.registration(req.agentKey),
    )
}

const unavailable = async (): Promise<string> => {
  throw new Error('object unavailable')
}

const body = async (response: HttpServerResponse.HttpServerResponse) => HttpServerResponse.toWeb(response).json()

describe('profile routes', () => {
  it('claim only avatars, samples, registration files and /data/profiles', () => {
    for (const path of [
      '/avatars/x.jpg',
      '/samples/x.jpg',
      '/profiles/k.json',
      '/data/profiles',
      '/data/profiles/2025',
    ])
      expect(isProfilePath(path), path).toBe(true)
    for (const path of ['/data/jobs', '/data/profilesx', '/api/agents/k/avatar'])
      expect(isProfilePath(path), path).toBe(false)
  })

  it('serves samples from R2 without reading managed profiles', async () => {
    const key = `samples/${'c'.repeat(64)}.webp`
    const bytes = new Uint8Array([1, 2, 3])
    const bucket = {
      get: async (wanted: string) => (wanted === key ? { arrayBuffer: async () => bytes.buffer } : null),
      put: async () => null,
    }
    const response = await profileRoute(`/${key}`, origin, { bucket, read: unavailable })
    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    })
    expect(new Uint8Array(await HttpServerResponse.toWeb(response).arrayBuffer())).toEqual(bytes)
    expect((await profileRoute('/samples/nope.png', origin, { bucket, read: unavailable })).status).toBe(404)
  })

  it('serve a registration file and public profiles from the management object', async () => {
    const read = management()
    const registration = await profileRoute('/profiles/reel-key.json', origin, { bucket: undefined, read })
    expect(registration.status).toBe(200)
    expect(await body(registration)).toMatchObject({ name: 'Reel', image: `${origin}/${avatar}` })
    const listed = await profileRoute('/data/profiles/2025', origin, { bucket: undefined, read })
    expect(await body(listed)).toEqual({
      ok: true,
      profiles: [
        { agentId: '2025', name: 'Reel', description: '', tagline: 'Explainers', image: `${origin}/${avatar}` },
      ],
    })
  })

  it('answer 503 when the management object cannot be read, and 404 for an unknown avatar', async () => {
    expect((await profileRoute('/data/profiles', origin, { bucket: undefined, read: unavailable })).status).toBe(503)
    const bucket = { get: async () => null, put: async () => null }
    expect((await profileRoute(`/${avatar}`, origin, { bucket, read: unavailable })).status).toBe(404)
  })
})

describe('workersAiImages', () => {
  it("decodes the model's base64 image into JPEG bytes", async () => {
    const asked: Array<{ model: string; inputs: unknown }> = []
    const model = workersAiImages({
      run: async (name, inputs) => {
        asked.push({ model: name, inputs })
        return { image: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0)) }
      },
    })
    const image = await model.generate('a friendly mascot')
    expect(image).toEqual({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), type: 'image/jpeg' })
    expect(asked).toEqual([
      { model: '@cf/black-forest-labs/flux-1-schnell', inputs: { prompt: 'a friendly mascot', steps: 6 } },
    ])
  })

  it('resizes the drawing to a 256 px WebP when the Images binding is there', async () => {
    const asked: unknown[] = []
    const images = {
      input: () => ({
        transform: (transform: unknown) => {
          asked.push(transform)
          return {
            output: async (options: unknown) => {
              asked.push(options)
              return { response: () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46])) }
            },
          }
        },
      }),
    }
    const model = workersAiImages({ run: async () => ({ image: btoa('jpeg') }) }, images)
    expect(await model.generate('x')).toEqual({ bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), type: 'image/webp' })
    expect(asked).toEqual([
      { width: 256, height: 256, fit: 'cover' },
      { format: 'image/webp', quality: 85 },
    ])
  })

  it('keeps the full JPEG when the Images binding refuses to resize', async () => {
    const images = {
      input: () => ({
        transform: () => ({
          output: async (): Promise<{ response(): Response }> => {
            throw new Error('Images transformations are unavailable')
          },
        }),
      }),
    }
    const model = workersAiImages({ run: async () => ({ image: btoa('jpeg') }) }, images)
    expect(await model.generate('x')).toEqual({ bytes: new TextEncoder().encode('jpeg'), type: 'image/jpeg' })
  })

  it("passes the model's refusal on in its own words", async () => {
    const model = workersAiImages({
      run: async () => {
        throw new Error('3036: daily free allocation exhausted')
      },
    })
    await expect(model.generate('x')).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('daily free allocation exhausted'),
    })
  })

  it('refuses an answer without an image', async () => {
    const model = workersAiImages({ run: async () => ({ error: 'capacity' }) })
    await expect(model.generate('x')).rejects.toThrow()
  })
})
