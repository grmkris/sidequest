import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Hex,
} from 'viem'
import { expect, test } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { assertLaunchGate } from '../src/deploy-preflight.ts'
import {
  launchOwnedContracts,
  launchClockReads,
  productionLaunchClocks,
  liveLaunchGate,
  opensAdmission,
  admissionDrainBinding,
  validateAdmissionMode,
  relayFloorWei,
  SAFE_GUARD_SLOT,
  SAFE_SINGLETON,
  type ChainConfig,
  type LaunchReader,
  type SafePolicy,
} from '../src/prod-config.ts'
import { RELAY_FLOOR_MAINNET } from '@sidequest/sdk'
import { parseHostedAdmission } from '@sidequest/board'

const abi = parseAbi([
  'function MIN_REVIEW_WINDOW() view returns (uint32)',
  'function MIN_DISPUTE_WINDOW() view returns (uint32)',
  'function MIN_ARBITRATION_WINDOW() view returns (uint32)',
  'function UNSTAKE_DELAY() view returns (uint48)',
  'function HOLDING_DELAY() view returns (uint48)',
  'function PROPOSAL_GRACE() view returns (uint48)',
  'function DELAY() view returns (uint48)',
  'function MAX_REVIEW_WINDOW() view returns (uint32)',
  'function MAX_DISPUTE_WINDOW() view returns (uint32)',
  'function MAX_ARBITRATION_WINDOW() view returns (uint32)',
  'function owner() view returns (address)',
  'function ADMIN_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function verifiers(address account) view returns (bool)',
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
])
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const
const SAFE = a(0x5afe)
const addresses = {
  core: a(0xc0),
  holding: a(0x10),
  evaluator: a(0x11),
  vault: a(0x12),
  feeSchedule: a(0x13),
}
const DEFAULT_ADMIN = toHex(0, { size: 32 })
const ADMIN = keccak256(toHex('ADMIN_ROLE'))
const FLOOR = RELAY_FLOOR_MAINNET
const lower = (value: string) => value.toLowerCase()
const OWNERS = [a(0x0a1), a(0x0a2)]
/** The artifact's pinned Safe policy (deployment.sidequest.safeOwners / safeThreshold). */
const POLICY: SafePolicy = { owners: OWNERS, threshold: 1 }
const SLOT_0 = toHex(0, { size: 32 })
const word = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex

/** A promoted mainnet config: the four owned by the Safe and the core's roles with it. */
function promoted(): ChainConfig {
  const config = structuredClone(mainnet) as unknown as ChainConfig
  config.deployment = {
    network: 'monad-mainnet',
    block: 123,
    core: addresses.core,
    factory: a(0xfa),
    main: {
      kind: 'sidequest-v1',
      factory: a(0xfa),
      holding: addresses.holding,
      evaluator: addresses.evaluator,
      openTokens: true,
    },
    sidequest: {
      block: 123,
      safe: SAFE,
      factory: a(0xfa),
      vault: addresses.vault,
      feeSchedule: addresses.feeSchedule,
    },
  }
  return config
}

interface LiveState {
  clocks: Record<string, number>
  code: Record<string, Hex>
  owners: Record<string, string>
  roles: Record<string, Set<string>>
  verifiers: Set<string>
  balances: Record<string, bigint>
  /** storage words, as `<address>:<slot>` */
  storage: Record<string, Hex>
  /** the Safe's own reads */
  safe: { version: string; owners: string[]; threshold: bigint; modules: string[] }
  /** reads that fail, as `method:address` (`call:<to>:<function>` for calls, `storage:<address>:<slot>` for storage) */
  failing: Set<string>
}

function live(config: ChainConfig): LiveState {
  const owners = Object.fromEntries(
    Object.values(addresses)
      .filter((value) => value !== addresses.core)
      .map((value) => [lower(value), SAFE]),
  )
  return {
    clocks: Object.fromEntries(
      launchClockReads.map(([name, getter, key]) => [
        `${lower(addresses[name])}:${getter}`,
        productionLaunchClocks[key],
      ]),
    ),
    code: { [lower(SAFE)]: '0x6080' },
    owners,
    roles: { [DEFAULT_ADMIN]: new Set([lower(SAFE)]), [ADMIN]: new Set([lower(SAFE)]) },
    verifiers: new Set([lower(config.roles.attester!)]),
    balances: { [lower(config.roles.relay!)]: FLOOR + 1n },
    storage: { [`${lower(SAFE)}:${SLOT_0}`]: word(SAFE_SINGLETON) },
    safe: { version: '1.4.1', owners: [...OWNERS], threshold: 1n, modules: [] },
    failing: new Set(),
  }
}

/** A read-only fake chain; it has no way to write, so a refusal cannot be followed by a mutation through it. */
function reader(state: LiveState): LaunchReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async code(address) {
      reads.push(`code:${lower(address)}`)
      if (state.failing.has(`code:${lower(address)}`)) throw new Error('rpc down')
      return state.code[lower(address)] ?? '0x'
    },
    async balance(address) {
      reads.push(`balance:${lower(address)}`)
      if (state.failing.has(`balance:${lower(address)}`)) throw new Error('rpc down')
      return state.balances[lower(address)] ?? 0n
    },
    async storage(address, slot) {
      const key = `${lower(address)}:${lower(slot)}`
      reads.push(`storage:${key}`)
      if (state.failing.has(`storage:${key}`)) throw new Error('rpc down')
      return state.storage[key] ?? toHex(0, { size: 32 })
    },
    async call(to, data) {
      const { functionName, args } = decodeFunctionData({ abi, data })
      reads.push(`call:${lower(to)}:${functionName}`)
      if (state.failing.has(`call:${lower(to)}:${functionName}`)) throw new Error('rpc down')
      const encode = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as never)
      switch (functionName) {
        case 'owner': {
          const owner = state.owners[lower(to)]
          if (owner === undefined) return '0x'
          return encode(owner)
        }
        case 'ADMIN_ROLE':
          return encode(ADMIN)
        case 'DEFAULT_ADMIN_ROLE':
          return encode(DEFAULT_ADMIN)
        case 'hasRole':
          return encode(state.roles[args![0] as string]?.has(lower(args![1] as string)) ?? false)
        case 'verifiers':
          return encode(lower(to) === lower(addresses.evaluator) && state.verifiers.has(lower(args![0] as string)))
        case 'VERSION':
          return encode(state.safe.version)
        case 'getOwners':
          return encode(state.safe.owners)
        case 'getThreshold':
          return encode(state.safe.threshold)
        case 'getModulesPaginated':
          return encode([state.safe.modules, a(1)])
      }
      if (functionName.startsWith('MAX_')) return encode(1209600)
      const clock = state.clocks[`${lower(to)}:${functionName}`]
      if (clock !== undefined) return encode(clock)
      throw new Error('unexpected call')
    },
  }
}

const gate = async (
  mutate: (state: LiveState, config: ChainConfig) => void = () => {},
  options: { floor?: bigint | undefined; policy?: SafePolicy | undefined } = {},
) => {
  const config = promoted()
  const state = live(config)
  mutate(state, config)
  return liveLaunchGate(
    config,
    reader(state),
    'floor' in options ? options.floor : FLOOR,
    'policy' in options ? options.policy : POLICY,
  )
}

test('D16: a promoted deployment with the Safe in custody, a verifier attester and a funded relay passes', async () => {
  expect(await gate()).toEqual([])
})

// ---- PROD-GATE-001: the Safe owns all four ----

test('PROD-GATE-001: a missing Safe, a Safe without code, or an unreadable Safe refuses', async () => {
  expect(
    await gate((_, config) => {
      delete config.deployment.sidequest!.safe
    }),
  ).toEqual(['launch:safe unset'])
  expect(
    await gate((_, config) => {
      config.deployment.sidequest!.safe = null
    }),
  ).toEqual(['launch:safe unset'])
  expect(
    await gate((state) => {
      state.code = {}
    }),
  ).toEqual(['launch:safe has no code'])
  expect(
    await gate((state) => {
      state.failing.add(`code:${lower(SAFE)}`)
    }),
  ).toEqual(['launch:safe code unreadable'])
})

test.each(launchOwnedContracts)(
  'PROD-GATE-001: %s still owned by the deployer (Safe only pending) refuses',
  async (name) => {
    const failures = await gate((state, config) => {
      state.owners[lower(addresses[name])] = config.roles.admin!
    })
    expect(failures).toEqual([`launch:owner:${name} is not the Safe`])
  },
)

test.each(launchOwnedContracts)('PROD-GATE-001: an unreadable owner() on %s refuses', async (name) => {
  expect(
    await gate((state) => {
      state.failing.add(`call:${lower(addresses[name])}:owner`)
    }),
  ).toEqual([`launch:owner:${name} unreadable`])
  expect(
    await gate((state) => {
      delete state.owners[lower(addresses[name])]
    }),
  ).toEqual([`launch:owner:${name} unreadable`])
})

// ---- LAUNCH-AUDIT-003: the Safe is the reviewed one: canonical, pinned owners and threshold, no module, no guard ----

test.each([
  [
    'one enabled module',
    (s: LiveState) => {
      s.safe.modules = [a(0xbeef)]
    },
    'launch:safe has a module enabled',
  ],
  [
    'a nonzero guard',
    (s: LiveState) => {
      s.storage[`${lower(SAFE)}:${SAFE_GUARD_SLOT}`] = word(a(0x9a2d))
    },
    'launch:safe has a guard set',
  ],
  [
    'a wrong owner set (one owner swapped)',
    (s: LiveState) => {
      s.safe.owners = [OWNERS[0]!, a(0xbad)]
    },
    'launch:safe owners differ from the pinned set',
  ],
  [
    'an extra owner',
    (s: LiveState) => {
      s.safe.owners = [...OWNERS, a(0xbad)]
    },
    'launch:safe owners differ from the pinned set',
  ],
  [
    'a missing owner',
    (s: LiveState) => {
      s.safe.owners = [OWNERS[0]!]
    },
    'launch:safe owners differ from the pinned set',
  ],
  [
    'a wrong threshold',
    (s: LiveState) => {
      s.safe.threshold = 2n
    },
    'launch:safe threshold differs from the pinned one',
  ],
  [
    'a non-canonical singleton',
    (s: LiveState) => {
      s.storage[`${lower(SAFE)}:${SLOT_0}`] = word(a(0x5a1e))
    },
    'launch:safe singleton is not the canonical SafeL2 v1.4.1',
  ],
  [
    'another VERSION',
    (s: LiveState) => {
      s.safe.version = '1.3.0'
    },
    'launch:safe VERSION is not 1.4.1',
  ],
] as const)('LAUNCH-AUDIT-003: a Safe with %s refuses', async (_, mutate, expected) => {
  expect(await gate(mutate)).toEqual([expected])
})

test('LAUNCH-AUDIT-003: owner order and case do not matter; an unpinned policy and every failed Safe read refuse', async () => {
  expect(
    await gate((state) => {
      state.safe.owners = [getAddress(OWNERS[1]!), OWNERS[0]!]
    }),
  ).toEqual([])
  expect(await gate(() => {}, { policy: undefined })).toEqual([
    'launch:safe owners/threshold not pinned in the artifact',
  ])
  expect(
    await gate((state) => {
      state.failing.add(`storage:${lower(SAFE)}:${SLOT_0}`)
    }),
  ).toEqual(['launch:safe singleton unreadable'])
  expect(
    await gate((state) => {
      state.failing.add(`storage:${lower(SAFE)}:${SAFE_GUARD_SLOT}`)
    }),
  ).toEqual(['launch:safe guard unreadable'])
  for (const fn of ['VERSION', 'getOwners', 'getThreshold', 'getModulesPaginated'] as const) {
    const label = {
      VERSION: 'VERSION',
      getOwners: 'owners',
      getThreshold: 'threshold',
      getModulesPaginated: 'modules',
    }[fn]
    expect(
      await gate((state) => {
        state.failing.add(`call:${lower(SAFE)}:${fn}`)
      }),
    ).toEqual([`launch:safe ${label} unreadable`])
  }
})

test('LAUNCH-AUDIT-003: Safe failure labels carry no values', async () => {
  const failures = await gate((state) => {
    state.safe.modules = [a(0xbeef)]
    state.safe.owners = [a(0xbad)]
    state.safe.threshold = 3n
    state.storage[`${lower(SAFE)}:${SAFE_GUARD_SLOT}`] = word(a(0x9a2d))
    state.storage[`${lower(SAFE)}:${SLOT_0}`] = word(a(0x5a1e))
  })
  expect(failures).toHaveLength(5)
  expect(failures.join(' ')).not.toMatch(/0x[0-9a-fA-F]{8,}/)
})

// ---- PROD-GATE-002: both core admin roles with the Safe, none with the deployer ----

test.each([
  [
    'DEFAULT_ADMIN_ROLE not with the Safe',
    (s: LiveState) => {
      s.roles[DEFAULT_ADMIN]!.delete(lower(SAFE))
    },
    'launch:core DEFAULT_ADMIN_ROLE not held by the Safe',
  ],
  [
    'ADMIN_ROLE not with the Safe',
    (s: LiveState) => {
      s.roles[ADMIN]!.delete(lower(SAFE))
    },
    'launch:core ADMIN_ROLE not held by the Safe',
  ],
  [
    'DEFAULT_ADMIN_ROLE still with the deployer',
    (s: LiveState, c: ChainConfig) => {
      s.roles[DEFAULT_ADMIN]!.add(lower(c.roles.admin!))
    },
    'launch:core DEFAULT_ADMIN_ROLE still held by the deployer',
  ],
  [
    'ADMIN_ROLE still with the deployer',
    (s: LiveState, c: ChainConfig) => {
      s.roles[ADMIN]!.add(lower(c.roles.admin!))
    },
    'launch:core ADMIN_ROLE still held by the deployer',
  ],
] as const)('PROD-GATE-002: %s refuses', async (_, mutate, expected) => {
  expect(await gate(mutate)).toEqual([expected])
})

test('PROD-GATE-002: custody is read live; a stale record of roles.admin proves nothing, and failed role reads refuse', async () => {
  // The config still names the old admin as deployer, but the role has since moved to yet another key.
  const failures = await gate((state) => {
    state.roles[ADMIN] = new Set([lower(a(0xbad))])
  })
  expect(failures).toEqual(['launch:core ADMIN_ROLE not held by the Safe'])
  expect(
    await gate((state) => {
      state.failing.add(`call:${lower(addresses.core)}:hasRole`)
    }),
  ).toEqual([
    'launch:core DEFAULT_ADMIN_ROLE of the Safe unreadable',
    'launch:core DEFAULT_ADMIN_ROLE of the deployer unreadable',
    'launch:core ADMIN_ROLE of the Safe unreadable',
    'launch:core ADMIN_ROLE of the deployer unreadable',
  ])
  expect(
    await gate((state) => {
      state.failing.add(`call:${lower(addresses.core)}:ADMIN_ROLE`)
    }),
  ).toEqual(['launch:core ADMIN_ROLE unreadable'])
  expect(
    await gate((_, config) => {
      config.roles.admin = SAFE
    }),
  ).toContain('launch:deployer must be a separate account')
})

// ---- PROD-GATE-003: the attester verifies on the v1 Evaluator ----

test('PROD-GATE-003: an attester that is not (or no longer) a verifier refuses; an unreadable flag refuses', async () => {
  expect(
    await gate((state) => {
      state.verifiers.clear()
    }),
  ).toEqual(['launch:attester is not a verifier on the v1 Evaluator'])
  expect(
    await gate((state) => {
      state.failing.add(`call:${lower(addresses.evaluator)}:verifiers`)
    }),
  ).toEqual(['launch:attester verifier unreadable'])
})

// ---- PROD-GATE-004: the relay holds strictly more than RELAY_FLOOR_MAINNET ----

test.each([
  ['zero', 0n],
  ['below the floor', FLOOR - 1n],
  ['exactly at the floor', FLOOR],
])('PROD-GATE-004: a relay balance %s refuses', async (_, balance) => {
  expect(
    await gate((state, config) => {
      state.balances[lower(config.roles.relay!)] = balance
    }),
  ).toEqual(['launch:relay at or below RELAY_FLOOR_MAINNET'])
})

test('PROD-GATE-004: an unreadable balance or an undefined floor refuses; the relay is the configured role, not any funded address', async () => {
  expect(
    await gate((state, config) => {
      state.failing.add(`balance:${lower(config.roles.relay!)}`)
    }),
  ).toEqual(['launch:relay balance unreadable'])
  expect(await gate(() => {}, { floor: undefined })).toEqual([
    'launch:relay floor undefined (RELAY_FLOOR_MAINNET, @sidequest/sdk)',
  ])
  expect(
    await gate((state, config) => {
      state.balances = { [lower(a(0xf00d))]: parseEther('100') }
      expect(config.roles.relay).not.toBe(a(0xf00d))
    }),
  ).toEqual(['launch:relay at or below RELAY_FLOOR_MAINNET'])
  expect(relayFloorWei('2')).toBe(FLOOR)
  expect(relayFloorWei(FLOOR)).toBe(FLOOR)
  expect(relayFloorWei(undefined)).toBeUndefined()
})

test('D16: failure labels carry no values beyond role names', async () => {
  const failures = await gate((state, config) => {
    state.code = {}
    state.verifiers.clear()
    state.balances[lower(config.roles.relay!)] = 0n
  })
  expect(failures.join(' ')).not.toMatch(/0x[0-9a-fA-F]{8,}/)
})

// ---- wiring: only a deploy that opens admission needs the gate ----

test('PROD-GATE-005: only explicit 0/false opens; missing, empty and malformed values always drain', async () => {
  for (const value of ['0', 'false', 'FALSE']) {
    expect(opensAdmission(value)).toBe(true)
    expect(admissionDrainBinding(value)).toBe('0')
  }
  for (const value of [undefined, '', '1', 'true', 'drain', ' 0', '0 ', 'off', 'null']) {
    expect(opensAdmission(value)).toBe(false)
    expect(admissionDrainBinding(value)).toBe('1')
    expect(parseHostedAdmission(admissionDrainBinding(value)).drain).toBe(true)
    expect(validateAdmissionMode({ admission: { drain: true } }, value)).toEqual([])
    expect(validateAdmissionMode({ admission: { drain: false } }, value)).toEqual(['admission runtime mismatch'])
  }
  for (const value of ['0', 'false']) expect(parseHostedAdmission(value).drain).toBe(false)
  expect(validateAdmissionMode({ admission: { drain: false } }, '0')).toEqual([])
  expect(validateAdmissionMode({ admission: { drain: true } }, '0')).toEqual(['admission runtime mismatch'])
})

test('D16: an opening deploy is refused before anything else when the gate fails; a drained deploy is not gated', async () => {
  const config = promoted()
  const state = live(config)
  state.owners[lower(addresses.vault)] = config.roles.admin!
  const chain = reader(state)
  await expect(assertLaunchGate(config, '0', chain, FLOOR, POLICY)).rejects.toThrow(
    'production launch gate refused: launch:owner:vault is not the Safe',
  )
  const reads = chain.reads.length
  for (const drain of [undefined, '', '1', 'invalid'])
    await expect(assertLaunchGate(config, drain, chain, FLOOR, POLICY)).resolves.toBeUndefined()
  expect(chain.reads.length).toBe(reads)
  state.owners[lower(addresses.vault)] = SAFE
  await expect(assertLaunchGate(config, '0', chain, FLOOR, POLICY)).resolves.toBeUndefined()
})

// D24: every constructor clock is independently read and fails closed.
test.each(launchClockReads)('CLOCKS: %s.%s mismatch and unreadable value refuse', async (name, getter) => {
  const label = `launch:clock:${name}.${getter}`
  expect(
    await gate((state) => {
      state.clocks[`${lower(addresses[name])}:${getter}`] = 1
    }),
  ).toEqual([`${label} differs from config`])
  expect(
    await gate((state) => {
      state.failing.add(`call:${lower(addresses[name])}:${getter}`)
    }),
  ).toEqual([`${label} unreadable`])
})

test('CLOCKS: testnet fast config passes readback; production cannot be overridden on 143', async () => {
  const fast = {
    minReviewWindow: 120,
    minDisputeWindow: 120,
    minArbitrationWindow: 300,
    unstakeDelay: 600,
    holdingDelay: 900,
    feeDelay: 300,
    proposalGrace: 1800,
  }
  const setup = (state: LiveState, config: ChainConfig) => {
    config.sidequest = { ...config.sidequest, clocks: fast }
    for (const [name, getter, key] of launchClockReads) state.clocks[`${lower(addresses[name])}:${getter}`] = fast[key]
  }
  expect(
    await gate((state, config) => {
      setup(state, config)
      config.chainId = 10143
    }),
  ).toEqual([])
  const failures = await gate(setup)
  for (const key of Object.keys(fast)) expect(failures).toContain(`launch:clocks:${key} config invalid`)
  expect(failures).toContain('launch:clock:vault.HOLDING_DELAY differs from config')
})

test('CLOCKS: partial, zero, out-of-range and cross-clock-invalid config refuse', async () => {
  for (const patch of [{ proposalGrace: 0 }, { minReviewWindow: 1209601 }, { holdingDelay: 60 }, { feeDelay: 59 }]) {
    const failures = await gate((_, config) => {
      config.chainId = 10143
      config.sidequest = { ...config.sidequest, clocks: { ...productionLaunchClocks, ...patch } }
    })
    expect(failures.length).toBeGreaterThan(0)
  }
  const failures = await gate((_, config) => {
    config.sidequest = { clocks: {} as never }
  })
  expect(failures).toHaveLength(7)
})
