import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { parseRoleArguments, roleEnvironment } from './role.ts'
import { runRoleLoop } from './loop.ts'

describe('role arguments and environment', () => {
  it('defaults to arbiter and accepts once', () => {
    expect(parseRoleArguments(['--once'])).toEqual({ role: 'arbiter', once: true })
    expect(parseRoleArguments(['--role', 'moderator'])).toEqual({ role: 'moderator', once: false })
    expect(parseRoleArguments(['--role', 'arbiter', '--once'])).toEqual({ role: 'arbiter', once: true })
    expect(() => parseRoleArguments(['--role'])).toThrow('--role')
    expect(parseRoleArguments(['--role', 'maintainer'])).toEqual({ role: 'maintainer', once: false })
    expect(() => parseRoleArguments(['--role', 'cto'])).toThrow('--role')
    expect(() => parseRoleArguments(['--bogus'])).toThrow('unknown option')
  })

  it('uses moderator settings and arbiter model fallbacks', () => {
    expect(
      roleEnvironment('moderator', {
        MODERATOR_PRIVATE_KEY: 'secret',
        ARBITER_MODEL: 'm',
        ARBITER_MODEL_BASE_URL: 'u',
        ARBITER_MODEL_API_KEY: 'k',
        HOME: '/tmp',
      }),
    ).toMatchObject({
      model: 'm',
      modelBaseUrl: 'u',
      modelApiKey: 'k',
      intervalSeconds: 15,
      cursorFile: '/tmp/.sidequest-moderator.cursor',
    })
    expect(
      roleEnvironment('arbiter', {
        V1_ARBITRATOR_PRIVATE_KEY: 'secret',
        ARBITER_MODEL: 'm',
        ARBITER_MODEL_BASE_URL: 'u',
        ARBITER_MODEL_API_KEY: 'k',
      }).intervalSeconds,
    ).toBe(60)
  })

  it('uses moderator-specific overrides without needing arbiter secrets', () => {
    const config = roleEnvironment('moderator', {
      MODERATOR_PRIVATE_KEY: 'test',
      MODERATOR_MODEL: 'mod',
      MODERATOR_MODEL_BASE_URL: 'https://model.invalid',
      MODERATOR_MODEL_API_KEY: 'test',
      MODERATOR_INTERVAL_SECONDS: '30',
      MODERATOR_CURSOR_FILE: '/tmp/mod.cursor',
    })
    expect(config).toMatchObject({ model: 'mod', intervalSeconds: 30, cursorFile: '/tmp/mod.cursor' })
    expect(() => roleEnvironment('moderator', { ...process.env, MODERATOR_PRIVATE_KEY: '' })).toThrow(
      'MODERATOR_PRIVATE_KEY',
    )
    expect(() => roleEnvironment('arbiter', {})).toThrow('V1_ARBITRATOR_PRIVATE_KEY')
  })

  it('runs sign-in and pass sequentially for every client in once mode', async () => {
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`)
    const order: string[] = []
    const client = {
      account,
      board: {
        signIn: async () => {
          order.push('sign-in')
          return { session: 'unit' }
        },
        call: vi.fn(),
      },
    }
    await runRoleLoop({
      clients: [client, client],
      once: true,
      intervalSeconds: 60,
      log: vi.fn(),
      pass: async () => {
        order.push('pass')
      },
    })
    expect(order).toEqual(['sign-in', 'pass', 'sign-in', 'pass'])
  })
})
