import { AdmissionRateLimits, fromNodeSqlite, ADMISSION_OBJECT_NAME } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { zeroAddress } from 'viem'
import { expect, it } from 'vitest'
import { admissionIpHash, enforceDirectoryIp, type AdmissionCall } from '../src/admission-rate.ts'
import { runDirectoryEdgeTool } from '../src/directory.ts'
import { directoryFixture } from './directory-fixture.ts'

it('the anonymous edge path used by REST admits prepared and signed mainnet directory tools without SIWE', async () => {
  const context = await directoryFixture()
  try {
    const limits = new AdmissionRateLimits(fromNodeSqlite(context.db))
    const admitted: Array<Pick<AdmissionCall, 'network' | 'tool' | 'ip'>> = []
    const bindings = {
      ...context.bindings,
      Board: {
        idFromName: (name: string) => {
          expect(name).toBe(ADMISSION_OBJECT_NAME)
          return { toString: () => name }
        },
        get: () => ({
          admitIp: async (input: Pick<AdmissionCall, 'network' | 'tool' | 'ip'>) => {
            admitted.push(input)
            return JSON.stringify(limits.consume(undefined, await admissionIpHash(input.ip), input.tool, context.now()))
          },
        }),
      },
    }
    const edge = { bindings, ip: '203.0.113.71' }
    const prepared = await runDirectoryEdgeTool(context.deps, edge, 'prepare_directory_enrollment', {
      agentId: '2013',
      payload: {
        profile: { name: 'Self-run', description: '', services: [] },
        delegate: zeroAddress,
        adDelegate: false,
        grantExpiresAt: 0,
        enrolled: true,
      },
    })
    if (!prepared.ok) throw new Error('prepare not admitted')
    // SAFETY: the REST prepare path returns the bare DirectoryService envelope.
    const record = prepared.result as sdk.DirectoryEnvelope
    expect(record.kind).toBe('Enrollment')
    expect(record).not.toHaveProperty('typedData')
    const signature = await context.key.signTypedData(sdk.directoryTypedData(record))
    expect(await runDirectoryEdgeTool(context.deps, edge, 'enroll_directory', { record, signature })).toMatchObject({
      ok: true,
      result: { agent: { enrolled: true } },
    })
    expect(admitted.map((input) => input.tool)).toEqual(['prepare_directory_enrollment', 'enroll_directory'])
    expect(admitted.every((input) => Object.keys(input).toSorted().join() === 'ip,network,tool')).toBe(true)
    for (let index = 2; index < 240; index++)
      expect(
        await enforceDirectoryIp(bindings, { network: 'monad-mainnet', tool: 'prepare_service_ad', ip: edge.ip }),
      ).toEqual({ ok: true })
    expect(
      await enforceDirectoryIp(bindings, { network: 'monad-mainnet', tool: 'prepare_service_ad', ip: edge.ip }),
    ).toMatchObject({ ok: false, code: 'rate-limited', retryAfter: expect.any(Number) })
    expect(context.db.prepare('SELECT key FROM admission_counters').all()).toHaveLength(1)
  } finally {
    context.close()
  }
})

it('requires a valid edge IP only in production posture and fails closed on unavailable counters', async () => {
  for (const ip of [undefined, '', 'spoofed', '192.0.2.1, 192.0.2.2'])
    expect(
      await enforceDirectoryIp(
        {},
        { network: 'monad-mainnet', tool: 'enroll_directory', ...(ip === undefined ? {} : { ip }) },
      ),
    ).toMatchObject({ ok: false, code: 'unavailable' })
  expect(
    await enforceDirectoryIp({}, { network: 'monad-mainnet', tool: 'enroll_directory', ip: '192.0.2.1' }),
  ).toMatchObject({ code: 'unavailable' })
  expect(await enforceDirectoryIp({}, { network: 'monad-testnet', tool: 'enroll_directory' })).toEqual({ ok: true })
  expect(
    await enforceDirectoryIp({ DEPLOY_STAGE: 'prod' }, { network: 'monad-testnet', tool: 'enroll_directory' }),
  ).toMatchObject({ code: 'unavailable' })
})
