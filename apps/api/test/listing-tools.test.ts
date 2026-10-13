import { DatabaseSync } from 'node:sqlite'
import { DirectoryError, DirectoryService, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { verifyTypedData, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it } from 'vitest'
import { type DirectoryCall, directoryObjectName, directoryPort } from '../src/directory-object.ts'
import { LISTING_TOOLS, networkTool, permittedTool, requiredToolScope } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

it('listing tools are work tools of the hosted agent on both networks since the mainnet signer rules (13 Oct)', () => {
  for (const name of LISTING_TOOLS) {
    expect(Object.hasOwn(agentTools, name)).toBe(true)
    expect(requiredToolScope(name)).toBe('sidequest:work')
    expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:work'] }, name)).toBe(true)
    expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:hire'] }, name)).toBe(false)
    expect(networkTool('monad-testnet', name)).toBe(true)
    expect(networkTool('monad-mainnet', name)).toBe(true)
  }
})

it('the directory port calls the agent own directory object and keeps its refusals', async () => {
  const deployment = sdk.deployment('monad-testnet')
  const audience = 'https://dev.sidequest.exchange'
  const key = privateKeyToAccount(generatePrivateKey())
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const service = new DirectoryService({
    sql: fromNodeSqlite(database),
    chainId: deployment.chainId,
    identityRegistry: deployment.identity,
    audience,
    agentId: '2013',
    now: () => 1_800_000_000,
    readIdentity: async () => ({ wallet: key.address, agentURI: 'data:application/json,{}' }),
    verify: async (address, record, signature) =>
      verifyTypedData({ address, ...sdk.directoryTypedData(record), signature }),
  })
  const names: string[] = []
  const calls: DirectoryCall[] = []
  const bindings = {
    DirectoryObject: {
      idFromName: (name: string) => {
        names.push(name)
        return name
      },
      get: () => ({
        call: async (request: DirectoryCall) => {
          calls.push(request)
          try {
            const result =
              request.action === 'read'
                ? await service.read()
                : request.action === 'prepare'
                  ? await service.prepare(request.kind!, request.payload)
                  : await service.submit(request.record, request.signature)
            return JSON.stringify({ ok: true, result })
          } catch (error) {
            return JSON.stringify(
              error instanceof DirectoryError
                ? { ok: false, code: error.code, message: error.message }
                : { ok: false, code: 'error', message: 'directory unavailable' },
            )
          }
        },
      }),
    },
  }
  const port = directoryPort(bindings, {
    network: 'monad-testnet',
    rpcUrl: 'http://127.0.0.1:1',
    audience,
    agentId: '2013',
  })
  expect(names).toEqual([directoryObjectName(deployment.chainId, deployment.identity, audience, '2013')])
  const record = await port.prepare('Enrollment', {
    profile: { name: 'Quill', description: '', services: [] },
    delegate: zeroAddress,
    adDelegate: false,
    grantExpiresAt: 0,
    enrolled: true,
  })
  expect(await port.submit(record, await key.signTypedData(sdk.directoryTypedData(record)))).toMatchObject({
    agentId: '2013',
    enrolled: true,
  })
  expect(calls.map((c) => [c.action, c.network, c.audience, c.agentId, 'admission' in c])).toEqual([
    ['prepare', 'monad-testnet', audience, '2013', false],
    ['submit', 'monad-testnet', audience, '2013', false],
  ])
  await expect(port.prepare('Enrollment', { enrolled: true })).rejects.toMatchObject({ code: 'invalid' })
  const revoke = await port.prepare('RevokeAd', { serviceId: 'translate' })
  await expect(
    port.submit(revoke, await privateKeyToAccount(generatePrivateKey()).signTypedData(sdk.directoryTypedData(revoke))),
  ).rejects.toMatchObject({ code: 'forbidden' })
})

it('a reply code the board does not know reads as an unavailable directory', async () => {
  const bindings = {
    DirectoryObject: {
      idFromName: (name: string) => name,
      get: () => ({ call: async () => JSON.stringify({ ok: false, code: 'teapot', message: 'no' }) }),
    },
  }
  const port = directoryPort(bindings, {
    network: 'monad-testnet',
    rpcUrl: 'http://127.0.0.1:1',
    audience: 'https://dev.sidequest.exchange',
    agentId: '2013',
  })
  await expect(port.read()).rejects.toMatchObject({ code: 'chain', message: 'no' })
})
