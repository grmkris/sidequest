import { DatabaseSync } from 'node:sqlite'
import { DirectoryError, DirectoryService, fromNodeSqlite } from '@sidequest/board'
import { fromNodeSqlite as asyncSql, migrate } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { verifyTypedData, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { directoryPolicy } from '../src/directory-admission.ts'
import { type DirectoryCall, directoryObjectName } from '../src/directory-object.ts'
import { migrateDirectory, projectDirectory } from '../src/directory.ts'

export const listingService = {
  serviceId: 'research',
  name: 'Research',
  description: 'Source-backed report',
  inputs: 'A question',
  outputs: 'A report',
  turnaroundSeconds: 3600,
  price: { model: 'quote', amountBaseUnits: '0', token: zeroAddress },
}

const now = () => Math.floor(Date.now() / 1000)

export async function directoryFixture(network: sdk.Network = 'monad-mainnet') {
  const db = new DatabaseSync(':memory:')
  const directoryDb = new DatabaseSync(':memory:')
  const sql = asyncSql(db)
  await migrate(sql)
  await migrateDirectory(sql)
  const key = privateKeyToAccount(generatePrivateKey())
  const config = sdk.deployment(network)
  const audience = 'https://sidequest.test'
  const service = new DirectoryService({
    sql: fromNodeSqlite(directoryDb),
    chainId: config.chainId,
    identityRegistry: config.identity,
    audience,
    agentId: '2013',
    now,
    readIdentity: async () => ({ wallet: key.address, agentURI: 'data:application/json,{}' }),
    verify: (address, record, signature) => verifyTypedData({ address, ...sdk.directoryTypedData(record), signature }),
  })
  const calls: DirectoryCall[] = []
  const bindings = {
    NETWORK: network,
    DEPLOY_STAGE: 'prod',
    PROD_ADMISSION_DRAIN: '0',
    DirectoryObject: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        call: async (request: DirectoryCall) => {
          calls.push(request)
          const denied = directoryPolicy(bindings, request)
          if (denied !== undefined) return JSON.stringify(denied)
          if (name !== directoryObjectName(config.chainId, config.identity, audience, '2013'))
            throw new Error('wrong object')
          try {
            let result
            if (request.action === 'read') result = await service.read()
            else if (request.action === 'prepare')
              result = await service.prepare(request.kind!, request.payload, request.expiresAt)
            else result = await service.submit(request.record, request.signature)
            await projectDirectory(sql, service.publicView(), audience)
            return JSON.stringify({ ok: true, result })
          } catch (error) {
            if (!(error instanceof DirectoryError)) throw error
            return JSON.stringify({ ok: false, code: error.code, message: error.message, retryAfter: error.retryAfter })
          }
        },
      }),
    },
  }
  const call = async (_id: string, request: DirectoryCall) =>
    JSON.parse(
      await bindings.DirectoryObject.get(directoryObjectName(config.chainId, config.identity, audience, '2013')).call(
        request,
      ),
    )
  return {
    db,
    sql,
    key,
    config,
    audience,
    now,
    service,
    bindings,
    calls,
    deps: { sql, network, rpcUrl: '', audience, call },
    close: () => {
      db.close()
      directoryDb.close()
    },
  }
}
