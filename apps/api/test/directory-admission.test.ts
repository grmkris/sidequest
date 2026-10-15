import { expect, it } from 'vitest'
import { directoryPolicy } from '../src/directory-admission.ts'
import type { DirectoryCall } from '../src/directory-object.ts'

const request = (patch: Partial<DirectoryCall> = {}): DirectoryCall => ({
  network: 'monad-mainnet',
  rpcUrl: '',
  audience: 'https://sidequest.exchange',
  agentId: '7',
  action: 'prepare',
  kind: 'Enrollment',
  payload: { enrolled: true },
  ...patch,
})
const open = { NETWORK: 'monad-mainnet', DEPLOY_STAGE: 'prod', PROD_ADMISSION_DRAIN: '0' }
const drained = { ...open, PROD_ADMISSION_DRAIN: '1' }

it('allows mainnet directory writes without a session or an admission namespace', () => {
  for (const kind of ['Enrollment', 'ServiceAd', 'Heartbeat', 'RevokeAd'] as const) {
    expect(directoryPolicy(open, request({ kind }))).toBeUndefined()
    expect(directoryPolicy(open, request({ action: 'submit', record: { kind } }))).toBeUndefined()
  }
})
it('drains new listings using the actual operation kind and signed enrollment payload', () => {
  for (const kind of ['Enrollment', 'ServiceAd', 'Heartbeat'] as const) {
    expect(directoryPolicy(drained, request({ kind }))).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'directory listing is paused',
    })
    expect(
      directoryPolicy(
        drained,
        request({
          action: 'submit',
          kind: 'RevokeAd',
          payload: { enrolled: false },
          record: { kind, payload: { enrolled: true } },
        }),
      ),
    ).toMatchObject({ code: 'forbidden' })
  }
})
it('always keeps reads, revocation and opt-out available during drain', () => {
  expect(directoryPolicy(drained, request({ action: 'read' }))).toBeUndefined()
  expect(directoryPolicy(drained, request({ kind: 'RevokeAd' }))).toBeUndefined()
  expect(directoryPolicy(drained, request({ action: 'submit', record: { kind: 'RevokeAd' } }))).toBeUndefined()
  expect(directoryPolicy(drained, request({ payload: { enrolled: false } }))).toBeUndefined()
  expect(
    directoryPolicy(
      drained,
      request({ action: 'submit', record: { kind: 'Enrollment', payload: { enrolled: false } } }),
    ),
  ).toBeUndefined()
})
it('refuses malformed actions, kinds and runtime network mismatches', () => {
  expect(directoryPolicy(open, request({ network: 'monad-testnet' }))).toMatchObject({ code: 'forbidden' })
  expect(directoryPolicy(open, request({ kind: 'Unknown' as never }))).toMatchObject({ code: 'invalid' })
  expect(directoryPolicy(open, request({ action: 'remove' as never }))).toMatchObject({ code: 'invalid' })
  expect(directoryPolicy(open, request({ action: 'submit', record: {} }))).toMatchObject({ code: 'invalid' })
})
it('uses mainnet or production posture and defaults missing drain to paused', () => {
  expect(directoryPolicy({ NETWORK: 'monad-mainnet' }, request())).toMatchObject({ code: 'forbidden' })
  const testnet = request({ network: 'monad-testnet' })
  expect(directoryPolicy({ NETWORK: 'monad-testnet' }, testnet)).toBeUndefined()
  expect(directoryPolicy({ NETWORK: 'monad-testnet', DEPLOY_STAGE: 'prod' }, testnet)).toMatchObject({
    code: 'forbidden',
  })
})
