import {
  admissionFailure,
  hostedToolNames,
  parseHostedAdmission,
  readOnlyHostedTools,
  recoveryHostedTools,
} from '@sidequest/board'
import { expect, test } from 'vitest'
import { hostedCallFailure } from '../src/hosted-admission.ts'
import { tools } from '../src/tools.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { directoryTools } from '../src/directory.ts'
import { telegramTools } from '../src/tools-telegram.ts'
import { agentTools } from '../src/tools-agents.ts'
import { admissionIpHash, enforceHostedRate, type AdmissionCall } from '../src/admission-rate.ts'

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const stranger = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
// find_services is a Worker-local read, before hosted board admission (like inbox).
const allTools = Object.keys({
  ...tools,
  ...tenantTools,
  ...directoryTools,
  ...telegramTools,
  create_agent: agentTools.create_agent,
  setup_status: agentTools.setup_status,
  update_profile: agentTools.update_profile,
  upload_sample: agentTools.upload_sample,
}).filter((name) => name !== 'find_services')
const policy = parseHostedAdmission('0')

test('every REST/MCP tool is classified; authenticated writes are open', () => {
  expect([...hostedToolNames].toSorted()).toEqual(allTools.toSorted())
  for (const tool of allTools) {
    expect(admissionFailure(policy, 'monad-mainnet', 'public', tool, undefined) === undefined, tool).toBe(
      readOnlyHostedTools.has(tool),
    )
    expect(admissionFailure(policy, 'monad-mainnet', 'new-board', tool, stranger) === undefined, tool).toBe(true)
    expect(admissionFailure(policy, 'monad-testnet', 'public', tool, undefined), tool).toBeUndefined()
  }
})

test.each(['workers.dev', 'direct REST', 'MCP', 'embed'])('%s does not take authentication from arguments', () => {
  const malicious = {
    caller: wallet,
    address: wallet,
    origin: 'https://sidequest.exchange',
    boardId: 'ops',
    network: 'monad-testnet',
    steps: [{ caller: wallet, tool: 'create_task' }],
    admission: { drain: false },
  }
  for (const tool of [
    'create_task',
    'request_quotes',
    'apply',
    'publish_transactions',
    'select_worker',
    'prepare_activation',
    'create_board',
    'update_board',
    'upgrade_account',
  ]) {
    expect(hostedCallFailure(policy, 'monad-mainnet', 'public', tool, malicious, undefined), tool).toBeDefined()
  }
})

test('alternate and newly created boards are open without invitation lists', () => {
  expect(hostedCallFailure(policy, 'monad-mainnet', 'other', 'create_task', {}, wallet)).toBeUndefined()
  expect(
    hostedCallFailure(policy, 'monad-mainnet', 'public', 'create_board', { slug: 'other' }, stranger),
  ).toBeUndefined()
  expect(
    hostedCallFailure(policy, 'monad-mainnet', 'public', 'update_board', { boardId: 'other' }, stranger),
  ).toBeUndefined()
})

test('drain preserves authenticated recovery while refusing new writes', () => {
  const draining = { drain: true }
  for (const tool of allTools) {
    if (readOnlyHostedTools.has(tool) || recoveryHostedTools.has(tool)) continue
    expect(hostedCallFailure(draining, 'monad-mainnet', 'public', tool, {}, wallet), tool).toBeDefined()
  }
  for (const tool of recoveryHostedTools)
    expect(hostedCallFailure(draining, 'monad-mainnet', 'other', tool, {}, wallet), tool).toBeUndefined()
})

test('IP counters normalize IPv6 and reject missing or spoofed forwarded chains', async () => {
  expect(await admissionIpHash('2001:db8::1')).toBe(await admissionIpHash('2001:0DB8:0:0:0:0:0:1'))
  for (const ip of [undefined, '', '192.0.2.1, 192.0.2.2', 'spoofed'])
    await expect(admissionIpHash(ip)).rejects.toThrow()
})

test('writes fail closed when the shared counter namespace is unavailable', async () => {
  expect(
    await enforceHostedRate({}, { network: 'monad-mainnet', tool: 'create_task', boardId: 'public' }),
  ).toMatchObject({ ok: false, code: 'unavailable' })
  expect(await enforceHostedRate({}, { network: 'monad-mainnet', tool: 'list_tasks', boardId: 'public' })).toEqual({
    ok: true,
  })
})

test('mainnet directory mutations use the same shared wallet/IP limiter as other writes', async () => {
  const calls: AdmissionCall[] = []
  const bindings = {
    Board: {
      idFromName: () => ({ toString: () => 'admission' }),
      get: () => ({
        admit: async (input: AdmissionCall) => {
          calls.push(input)
          return JSON.stringify({ ok: true })
        },
      }),
    },
  }
  expect(
    await enforceHostedRate(bindings, {
      network: 'monad-mainnet',
      tool: 'prepare_directory_enrollment',
      boardId: 'public',
      caller: wallet,
      ip: '192.0.2.10',
    }),
  ).toEqual({ ok: true })
  expect(calls[0]).toMatchObject({ tool: 'prepare_directory_enrollment', caller: wallet, ip: '192.0.2.10' })
})

test('prod testnet has the production drain and counter posture while dev testnet stays open', async () => {
  expect(
    admissionFailure(parseHostedAdmission('1'), 'monad-testnet', 'public', 'create_task', wallet, 'prod'),
  ).toContain('drain')
  expect(admissionFailure(policy, 'monad-testnet', 'public', 'create_task', undefined, 'prod')).toContain(
    'authenticated',
  )
  expect(admissionFailure(policy, 'monad-testnet', 'public', 'create_task', wallet, 'prod')).toBeUndefined()
  expect(
    await enforceHostedRate(
      { DEPLOY_STAGE: 'prod' },
      { network: 'monad-testnet', tool: 'create_task', boardId: 'public' },
    ),
  ).toMatchObject({ ok: false, code: 'unavailable' })
  expect(
    await enforceHostedRate(
      { DEPLOY_STAGE: 'dev' },
      { network: 'monad-testnet', tool: 'create_task', boardId: 'public' },
    ),
  ).toEqual({ ok: true })
})
