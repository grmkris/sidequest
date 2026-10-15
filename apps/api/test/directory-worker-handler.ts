/** Test-only entry points expose private RPC to local workerd drills; never deployed remotely. */
import { ADMISSION_OBJECT_NAME, SESSION_SCHEMA } from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import type { AdmissionCall } from '../src/admission-rate.ts'
import Board from '../src/board.ts'
import { Database } from '../src/database.ts'
import DirectoryObject, { type DirectoryCall } from '../src/directory-object.ts'

export const directoryProbeHandler = Effect.gen(function* () {
  const boards = yield* Board
  const directory = yield* DirectoryObject
  const facts = yield* Cloudflare.D1.QueryDatabase(Database)
  return {
    fetch: Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const body = (yield* req.json) as unknown as {
        name: string
        call: DirectoryCall
        admit?: AdmissionCall
        admitIp?: Pick<AdmissionCall, 'network' | 'tool' | 'ip'>
        seed?: { token: string; wallet: string }
      }
      const sql = fromD1((yield* facts.raw) as never)
      yield* Effect.promise(() => sql.batch(SESSION_SCHEMA.map((query) => ({ query, params: [] }))))
      if (body.seed !== undefined)
        yield* Effect.promise(() =>
          sql.batch([
            {
              query:
                'INSERT OR REPLACE INTO sessions (id, address, origin, board_id, expires_at) VALUES (?, ?, ?, ?, ?)',
              params: [
                body.seed!.token,
                body.seed!.wallet,
                'https://test.invalid',
                'public',
                Math.floor(Date.now() / 1000) + 3600,
              ],
            },
          ]),
        )
      const reply =
        body.admitIp !== undefined
          ? yield* boards.getByName(body.name || ADMISSION_OBJECT_NAME).admitIp(body.admitIp)
          : body.admit === undefined
            ? yield* directory.getByName(body.name).call(body.call)
            : yield* boards.getByName(ADMISSION_OBJECT_NAME).admit(body.admit)
      return HttpServerResponse.text(reply, { headers: { 'content-type': 'application/json' } })
    }),
  }
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
