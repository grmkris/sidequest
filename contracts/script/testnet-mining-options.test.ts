import { expect, test, vi } from 'vitest'
import { createPublicClient, custom, encodeFunctionResult, parseAbi } from '../../scripts/mining/viem.ts'
import { EpochNotEnded, miningOptions, requireEndedEpoch, requirePriceEpoch, validateOwner } from './testnet-mining-options.ts'

const readContract = async () => 100n

test('keeps the original epoch-0 command and accepts an explicit earned epoch', () => {
  expect(miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY'])).toMatchObject({ epoch: 0n })
  expect(miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', '7'])).toMatchObject({ epoch: 7n })
  expect(() => miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', '07'])).toThrow('usage:')
  expect(() => miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', '-1'])).toThrow('usage:')
  expect(() => miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', (2n ** 256n).toString()])).toThrow('uint256')
})

test('price input must name the selected epoch', () => {
  expect(() => requirePriceEpoch({ epoch: '2' }, 2n)).not.toThrow()
  expect(() => requirePriceEpoch({ message: { epoch: '2' } }, 2n)).not.toThrow()
  expect(() => requirePriceEpoch({ epoch: '1' }, 2n)).toThrow('selected epoch')
})

test('publish-only defaults and named owner/stage/log options are independent of option order', () => {
  expect(miningOptions(['prices.json', 'out'])).toEqual({
    inputArg: 'prices.json', outArg: 'out', epoch: 0n, claimKeyEnv: undefined,
    ownerKeyEnv: 'SAFE_OWNER_PRIVATE_KEY', stage: undefined, logs: 'hypersync',
  })
  for (const stage of ['dev', 'prod']) {
    expect(miningOptions(['prices.json', 'out', '--logs', 'rpc', '--stage', stage, '--epoch', '45',
      '--owner-key-env', 'SAFE_TESTNET_OWNER', '--claim-key-env', 'CREATOR_KEY'])).toMatchObject({
      epoch: 45n, logs: 'rpc', stage, ownerKeyEnv: 'SAFE_TESTNET_OWNER', claimKeyEnv: 'CREATOR_KEY',
    })
  }
})

test('refuses malformed, missing, duplicate or unknown options without echoing values', () => {
  for (const suffix of [
    ['--stage', 'local'], ['--stage'], ['--logs', 'env-secret'], ['--logs'], ['--owner-key-env'],
    ['--owner-key-env', 'env-secret'], ['--claim-key-env'], ['--claim-key-env', 'env-secret'],
    ['--epoch'], ['--epoch', '1', '--epoch', '2'], ['--unknown', 'env-secret'],
  ]) {
    expect(() => miningOptions(['prices.json', 'out', ...suffix])).toThrow('usage:')
    expect(() => miningOptions(['prices.json', 'out', ...suffix])).not.toThrow('env-secret')
  }
})

test('owner must be both reviewed and returned by the on-chain getOwners read', async () => {
  const safe = '0x0000000000000000000000000000000000000001', owner = '0x0000000000000000000000000000000000000002'
  const abi = parseAbi(['function getOwners() view returns (address[])'])
  const getOwners = vi.fn(async () => encodeFunctionResult({ abi, functionName: 'getOwners', result: [owner] }))
  const client = createPublicClient({ transport: custom({ request: getOwners }, { retryCount: 0 }) })
  await expect(validateOwner(client, safe, owner, [owner])).resolves.toBeUndefined()
  expect(getOwners).toHaveBeenCalledTimes(1)
  await expect(validateOwner(client, safe, owner, [])).rejects.toThrow('reviewed Safe owner')
  getOwners.mockImplementation(async () => encodeFunctionResult({ abi, functionName: 'getOwners', result: [] }))
  await expect(validateOwner(client, safe, owner, [owner])).rejects.toThrow('current Safe owner')
})

test('earned epoch waits for both latest and finalized chain time', async () => {
  const latest = { timestamp: 100n }, finalized = { timestamp: 99n }
  const client = { readContract, getBlock: async ({ blockTag }: { blockTag?: string } = {}) => blockTag === 'finalized' ? finalized : latest }
  await expect(requireEndedEpoch(client as never, '0x0000000000000000000000000000000000000001', 3n)).rejects.toBeInstanceOf(EpochNotEnded)
  const ended = { readContract, getBlock: async ({ blockTag }: { blockTag?: string } = {}) => blockTag === 'finalized' ? { timestamp: 100n } : { timestamp: 101n } }
  await expect(requireEndedEpoch(ended as never, '0x0000000000000000000000000000000000000001', 3n)).resolves.toBeUndefined()
})
