import {
  decodeAllowedCalldataTerms,
  decodeERC20TokenPeriodTransferTerms,
  decodeERC20TransferAmountTerms,
  decodeExactExecutionTerms,
  decodeLimitedCallsTerms,
  decodeTimestampTerms,
} from '@metamask/delegation-core'
import { DELEGATOR_CONTRACTS } from '@metamask/delegation-deployments'
import { type Address, type Hex, encodeFunctionData, erc20Abi, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { deployment } from '../deployment.ts'
import { delegationHash } from './index.ts'
import {
  type PermissionRequest,
  type PermissionSpec,
  adjustPermission,
  assertPermission,
  buildPermission,
  checkPermissionExecution,
  describePermission,
  parsePermissionRequest,
  parsePermissionSpec,
  permissionEnforcers,
  permissionRisks,
  permissionSpecJson,
  supportedPermissions,
} from './permissions.ts'

const d = deployment('monad-testnet')
const operator = getAddress('0xb9970a6371358f6c74dfb15a7cb2653e3ae3e471')
const agent = getAddress('0x2222222222222222222222222222222222222222')
const recipient = getAddress('0x3333333333333333333333333333333333333333')
const token = d.rewardTokens[0]!
const now = 1_791_000_000
const scope = { chainId: d.chainId, agent, operator, now }
const expiry = (seconds: number) => [{ type: 'expiry', data: { timestamp: now + seconds } }]

const periodic: PermissionRequest = {
  chainId: '0x279f',
  from: operator,
  to: agent,
  rules: expiry(7 * 86_400),
  permission: {
    type: 'erc20-token-periodic',
    isAdjustmentAllowed: true,
    data: {
      tokenAddress: token,
      periodAmount: '0x989680',
      periodDuration: 86_400,
      recipient,
      justification: 'Pay Mercator top-ups',
    },
  },
}
const transfer = (to: Address, value: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] })
const exactCall = transfer(recipient, 5n)
const call: PermissionRequest = {
  chainId: d.chainId,
  to: agent,
  rules: expiry(3600),
  permission: { type: 'sidequest:contract-call', data: { target: token, calldata: exactCall } },
}
const spec = (terms: PermissionSpec['terms'], seconds = 86_400): PermissionSpec => ({
  kind: 'permission',
  delegator: operator,
  agent,
  salt: 7n,
  start: now,
  expiry: now + seconds,
  terms,
})

describe('parsePermissionRequest', () => {
  it('reads the ERC-7715 periodic, allowance and exact-call envelopes', () => {
    expect(parsePermissionRequest(periodic, scope)).toEqual({
      expiry: now + 7 * 86_400,
      adjustable: true,
      justification: 'Pay Mercator top-ups',
      terms: { type: 'erc20-token-periodic', token, periodAmount: 10_000_000n, periodDuration: 86_400, recipient },
    })
    expect(
      parsePermissionRequest(
        {
          ...periodic,
          permission: {
            type: 'erc20-token-allowance',
            data: { tokenAddress: token, allowanceAmount: '25', recipient },
          },
        },
        scope,
      ).terms,
    ).toEqual({ type: 'erc20-token-allowance', token, amount: 25n, recipient })
    expect(parsePermissionRequest(call, scope)).toMatchObject({
      adjustable: false,
      terms: { type: 'sidequest:contract-call', target: token, value: 0n, callData: exactCall },
    })
  })

  it.each([
    ['another chain', { chainId: 143 }],
    ['another delegate', { to: recipient }],
    ['another delegator', { from: recipient }],
    ['no expiry', { rules: [] }],
    ['an unknown rule', { rules: [{ type: 'call-limit', data: {} }] }],
    ['a past expiry', { rules: [{ type: 'expiry', data: { timestamp: now } }] }],
    ['a too-long expiry', { rules: expiry(31 * 86_400) }],
    ['an unknown type', { permission: { type: 'native-token-stream', data: {} } }],
    [
      'an unknown field',
      { permission: { type: 'erc20-token-periodic', data: { ...periodic.permission.data, startTime: 1 } } },
    ],
    [
      'a zero amount',
      { permission: { type: 'erc20-token-periodic', data: { ...periodic.permission.data, periodAmount: '0' } } },
    ],
    [
      'a fractional amount',
      { permission: { type: 'erc20-token-periodic', data: { ...periodic.permission.data, periodAmount: '1.5' } } },
    ],
    [
      'a short period',
      { permission: { type: 'erc20-token-periodic', data: { ...periodic.permission.data, periodDuration: 60 } } },
    ],
    [
      'a missing recipient',
      {
        permission: {
          type: 'erc20-token-periodic',
          data: { tokenAddress: token, periodAmount: '1', periodDuration: 86_400 },
        },
      },
    ],
  ])('refuses %s', (_, change) => {
    expect(() => parsePermissionRequest({ ...periodic, ...change } as PermissionRequest, scope)).toThrow()
  })

  it('caps an exact call at a day and needs its full calldata', () => {
    expect(() => parsePermissionRequest({ ...call, rules: expiry(86_401) }, scope)).toThrow(/24 hours/)
    expect(() =>
      parsePermissionRequest(
        { ...call, permission: { type: 'sidequest:contract-call', data: { target: token, calldata: '0xa905' } } },
        scope,
      ),
    ).toThrow(/calldata/)
  })
})

describe('adjustPermission', () => {
  const parsed = parsePermissionRequest(periodic, scope)
  it('lets the operator shorten the expiry and lower the amount', () => {
    expect(adjustPermission(parsed, { expiry: now + 86_400, periodAmount: 1n })).toMatchObject({
      expiry: now + 86_400,
      terms: { periodAmount: 1n },
    })
  })
  it('never widens, and refuses any change to a fixed request', () => {
    expect(() => adjustPermission(parsed, { expiry: parsed.expiry + 1 })).toThrow()
    expect(() => adjustPermission(parsed, { periodAmount: 10_000_001n })).toThrow()
    expect(() => adjustPermission(parsePermissionRequest(call, scope), { expiry: now + 60 })).toThrow(/does not allow/)
  })
})

describe('buildPermission', () => {
  it('uses the canonical v1.3.0 enforcers, which mainnet has at the same addresses', () => {
    expect(permissionEnforcers(d).exactExecution).toBe('0x146713078D39eCC1F5338309c28405ccf85Abfbb')
    expect(supportedPermissions(d)).toEqual(
      Object.fromEntries(
        ['erc20-token-periodic', 'erc20-token-allowance', 'sidequest:contract-call'].map((type) => [
          type,
          { chainIds: ['0x279f'], ruleTypes: ['expiry'] },
        ]),
      ),
    )
    // Mainnet has no recorded deployment before launch; its canonical table must still carry every enforcer used here.
    const main = (DELEGATOR_CONTRACTS as Record<string, Record<number, Record<string, string>>>)['1.3.0']![143]!
    expect(main.ExactExecutionEnforcer).toBe('0x146713078D39eCC1F5338309c28405ccf85Abfbb')
    for (const name of [
      'ERC20PeriodTransferEnforcer',
      'ERC20TransferAmountEnforcer',
      'AllowedCalldataEnforcer',
      'TimestampEnforcer',
      'LimitedCallsEnforcer',
      'DelegationManager',
    ]) {
      expect(main[name]).toBe(
        (DELEGATOR_CONTRACTS as Record<string, Record<number, Record<string, string>>>)['1.3.0']![10143]![name],
      )
    }
  })

  it('builds a periodic transfer to one pinned recipient that the MetaMask decoders read back', () => {
    const terms = parsePermissionRequest(periodic, scope).terms
    const delegation = buildPermission(d, spec(terms))
    const e = permissionEnforcers(d)
    expect(delegation).toMatchObject({ delegator: operator, delegate: agent })
    const by = (enforcer: Address) =>
      delegation.caveats.find((item) => item.enforcer.toLowerCase() === enforcer.toLowerCase())!.terms
    expect(decodeERC20TokenPeriodTransferTerms(by(e.erc20PeriodTransfer))).toMatchObject({
      periodAmount: 10_000_000n,
      periodDuration: 86_400,
      startDate: now,
    })
    expect(decodeAllowedCalldataTerms(by(e.allowedCalldata))).toMatchObject({ startIndex: 4 })
    expect((decodeAllowedCalldataTerms(by(e.allowedCalldata)).value as Hex).toLowerCase()).toContain(
      recipient.slice(2).toLowerCase(),
    )
    expect(decodeTimestampTerms(by(e.timestamp))).toMatchObject({ afterThreshold: 0, beforeThreshold: now + 86_400 })
  })

  it('builds a one-off allowance and an exact one-shot call', () => {
    const e = permissionEnforcers(d)
    const allowance = buildPermission(d, spec({ type: 'erc20-token-allowance', token, amount: 25n, recipient }))
    expect(
      decodeERC20TransferAmountTerms(
        allowance.caveats.find((item) => item.enforcer.toLowerCase() === e.erc20TransferAmount.toLowerCase())!.terms,
      ),
    ).toMatchObject({ maxAmount: 25n })
    const exact = buildPermission(
      d,
      spec({ type: 'sidequest:contract-call', target: token, value: 0n, callData: exactCall }, 3600),
    )
    const by = (enforcer: Address) =>
      exact.caveats.find((item) => item.enforcer.toLowerCase() === enforcer.toLowerCase())!.terms
    expect(decodeExactExecutionTerms(by(e.exactExecution))).toMatchObject({
      execution: { value: 0n, callData: exactCall },
    })
    expect(decodeLimitedCallsTerms(by(e.limitedCalls))).toEqual({ limit: 1 })
    expect(() =>
      buildPermission(
        d,
        spec({ type: 'sidequest:contract-call', target: token, value: 0n, callData: exactCall }, 86_401),
      ),
    ).toThrow()
  })

  it('has a stable hash, survives storage and refuses any mutated or extra caveat', () => {
    const s = spec(parsePermissionRequest(periodic, scope).terms)
    const delegation = buildPermission(d, s)
    expect(delegationHash(buildPermission(d, parsePermissionSpec(permissionSpecJson(s))))).toBe(
      delegationHash(delegation),
    )
    expect(() => assertPermission(d, s, delegation)).not.toThrow()
    const mutated = {
      ...delegation,
      caveats: delegation.caveats.map((item, index) => (index === 1 ? { ...item, terms: '0x00' as Hex } : item)),
    }
    expect(() => assertPermission(d, s, mutated)).toThrow()
    expect(() =>
      assertPermission(d, s, { ...delegation, caveats: [...delegation.caveats, delegation.caveats[0]!] }),
    ).toThrow()
    expect(() => assertPermission(d, s, { ...delegation, delegate: recipient })).toThrow()
    expect(() =>
      assertPermission(d, s, {
        ...delegation,
        caveats: delegation.caveats.map((item, index) => (index === 0 ? { ...item, args: '0x01' as Hex } : item)),
      }),
    ).toThrow()
  })
})

describe('checkPermissionExecution', () => {
  const periodicSpec = spec({
    type: 'erc20-token-periodic',
    token,
    periodAmount: 10n,
    periodDuration: 86_400,
    recipient,
  })
  const exactSpec = spec({ type: 'sidequest:contract-call', target: token, value: 0n, callData: exactCall }, 3600)
  it('allows a transfer to the pinned recipient within the amount, and the exact call', () => {
    expect(() =>
      checkPermissionExecution(periodicSpec, { target: token, value: 0n, callData: transfer(recipient, 10n) }, now),
    ).not.toThrow()
    expect(() =>
      checkPermissionExecution(exactSpec, { target: token, value: 0n, callData: exactCall }, now),
    ).not.toThrow()
  })
  it.each([
    ['over the amount', { target: token, value: 0n, callData: transfer(recipient, 11n) }],
    ['to another recipient', { target: token, value: 0n, callData: transfer(agent, 1n) }],
    ['with native value', { target: token, value: 1n, callData: transfer(recipient, 1n) }],
    ['on another token', { target: recipient, value: 0n, callData: transfer(recipient, 1n) }],
    [
      'as an approve',
      {
        target: token,
        value: 0n,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [recipient, 1n] }),
      },
    ],
    ['with trailing bytes', { target: token, value: 0n, callData: `${transfer(recipient, 1n)}00` as Hex }],
  ])('refuses a transfer %s', (_, execution) => {
    expect(() => checkPermissionExecution(periodicSpec, execution, now)).toThrow()
  })
  it('refuses a different call and anything after expiry', () => {
    expect(() =>
      checkPermissionExecution(exactSpec, { target: token, value: 0n, callData: transfer(recipient, 6n) }, now),
    ).toThrow()
    expect(() =>
      checkPermissionExecution(
        periodicSpec,
        { target: token, value: 0n, callData: transfer(recipient, 1n) },
        now + 86_400,
      ),
    ).toThrow(/expired/)
  })
})

describe('describe and risks', () => {
  it('describes the permission in plain fields', () => {
    expect(
      describePermission(
        spec({ type: 'erc20-token-periodic', token, periodAmount: 10n, periodDuration: 86_400, recipient }),
      ),
    ).toEqual({
      type: 'erc20-token-periodic',
      from: operator,
      to: agent,
      validAfter: now,
      expiresAt: now + 86_400,
      token,
      recipient,
      amount: '10',
      periodSeconds: 86_400,
    })
  })
  it('flags what an operator should notice', () => {
    const codes = (s: PermissionSpec, facts: Parameters<typeof permissionRisks>[2]) =>
      permissionRisks(d, s, facts).map((risk) => risk.code)
    expect(
      codes(
        spec({ type: 'erc20-token-periodic', token, periodAmount: 10n, periodDuration: 86_400, recipient }, 8 * 86_400),
        { now, balance: 15n, addressBook: [] },
      ),
    ).toEqual(['large-share', 'unknown-recipient', 'long-expiry'])
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [recipient, 1n] })
    expect(
      codes(
        spec({ type: 'sidequest:contract-call', target: d.delegation.manager, value: 1n, callData: approve }, 3600),
        { now, knownTargets: [token], simulationReverted: true, adjusted: true },
      ),
    ).toEqual([
      'native-value',
      'dangerous-method',
      'delegation-manager',
      'unknown-target',
      'simulation-reverted',
      'adjusted',
    ])
    expect(
      codes(spec({ type: 'erc20-token-allowance', token, amount: 1n, recipient }), {
        now,
        balance: 100n,
        addressBook: [recipient],
      }),
    ).toEqual([])
  })
})
