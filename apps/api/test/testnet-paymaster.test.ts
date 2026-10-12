import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, erc20Abi, recoverMessageAddress, slice, size } from 'viem'
import { type Json, advanceExecution, redeemCalldata, testnetPaymasterHash, toBundlerJson } from '@sidequest/sdk'
import { testnetPaymasterRpc } from '../src/testnet-paymaster.ts'
import {
  approve,
  charged,
  mainnet,
  node,
  operation,
  paymaster,
  paymasterParams,
  sender,
  signerKey,
  work,
} from './aa-fixtures.ts'

let time = 1_790_000_000
const service = (over: Parameters<typeof node>[0] = {}, key: string | undefined = signerKey) => {
  time += 61
  const fixedTime = time
  const chain = node(over)
  return {
    chain,
    time: fixedTime,
    rpc: testnetPaymasterRpc({ deployment: charged, node: chain.rpc, signerKey: key, now: () => fixedTime }),
  }
}
const pull = (amount = 1_000_000n) => ({
  to: charged.delegation.manager,
  value: 0n,
  data: redeemCalldata(
    { delegate: sender, delegator: work.to, authority: `0x${'ff'.repeat(32)}`, caveats: [], salt: 0n, signature: '0x' },
    advanceExecution(charged.aa.gasToken, sender, amount),
  ),
})

describe('testnet paymaster ERC-7677 service', () => {
  it('returns onchain token quotes and caches resolved prices for five seconds', async () => {
    const s = service()
    const params: Json[] = [{ tokens: [charged.aa.gasToken] }, charged.aa.entryPoint, '0x279f']
    expect(await s.rpc('pimlico_getTokenQuotes', params)).toEqual({
      quotes: [{ paymaster, token: charged.aa.gasToken, exchangeRate: '0x6d60', postOpGas: '0x1e848' }],
    })
    await s.rpc('pimlico_getTokenQuotes', params)
    expect(s.chain.calls).toHaveLength(2)
  })

  it('returns a 77-byte window and dummy signature with measured gas margins', async () => {
    const s = service()
    const answer = await s.rpc('pm_getPaymasterStubData', paymasterParams())
    expect(answer).toMatchObject({
      paymaster,
      paymasterVerificationGasLimit: '0x186a0',
      paymasterPostOpGasLimit: '0x30d40',
    })
    // SAFETY: this service method returns the ERC-7677 paymaster data envelope tested above.
    const data = (answer as { paymasterData: `0x${string}` }).paymasterData
    expect(size(data)).toBe(77)
    expect(BigInt(slice(data, 0, 6))).toBe(BigInt(s.time + 600))
    expect(BigInt(slice(data, 6, 12))).toBe(BigInt(s.time - 60))
    expect(slice(data, 12)).toBe(`0x${'00'.repeat(65)}`)
    expect(s.chain.calls).toHaveLength(0)
  })

  it('signs the final op as an EIP-191 message after checking funds and allowance', async () => {
    const s = service()
    const op = operation()
    // SAFETY: pm_getPaymasterData returns the ERC-7677 envelope containing a checked hex suffix.
    const answer = (await s.rpc('pm_getPaymasterData', paymasterParams(op))) as { paymasterData: `0x${string}` }
    const hash = testnetPaymasterHash(op, 10143, paymaster, BigInt(s.time + 600), BigInt(s.time - 60))
    expect(await recoverMessageAddress({ message: { raw: hash }, signature: slice(answer.paymasterData, 12) })).toBe(
      privateKeyToAccount(signerKey).address,
    )
    expect(JSON.stringify(answer)).not.toContain(signerKey)
  })

  it('accepts an existing balance and allowance without appending an approval', async () => {
    const s = service({ allowance: 1_000_000n })
    await expect(s.rpc('pm_getPaymasterData', paymasterParams(operation([work])))).resolves.toHaveProperty(
      'paymasterData',
    )
  })

  it('accepts a real first-call gas pull and simulates its permission before crediting it', async () => {
    const s = service({ balance: 0n })
    await expect(
      s.rpc('pm_getPaymasterData', paymasterParams(operation([pull(), work, approve()]))),
    ).resolves.toHaveProperty('paymasterData')
    expect(s.chain.calls.filter((call) => JSON.stringify(call).includes('"from"'))).toHaveLength(1)
    const failed = service({ balance: 0n, failPull: true })
    await expect(failed.rpc('pm_getPaymasterData', paymasterParams(operation([pull(), approve()])))).rejects.toThrow(
      'not redeemable',
    )
  })

  it('refuses allowance-only funding, small/late/spoofed pulls, token depletion and final approval revocation', async () => {
    const spend = {
      to: charged.aa.gasToken,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [work.to, 1_000_000n] }),
    }
    for (const calls of [
      [work, approve()],
      [pull(1n), approve()],
      [work, pull(), approve()],
      [{ ...pull(), to: work.to }, approve()],
    ]) {
      const s = service({ balance: 0n, allowance: 1_000_000n })
      await expect(s.rpc('pm_getPaymasterData', paymasterParams(operation(calls)))).rejects.toMatchObject({
        code: 'refused',
      })
    }
    for (const calls of [[work], [approve(), approve(0n)], [spend, approve()]]) {
      const s = service()
      await expect(s.rpc('pm_getPaymasterData', paymasterParams(operation(calls)))).rejects.toMatchObject({
        code: 'refused',
      })
    }
  })

  it('refuses mainnet, a wrong EntryPoint/token/paymaster and malformed or native-value batches', async () => {
    const s = service()
    const params = paymasterParams()
    for (const altered of [
      [params[0]!, params[1]!, '0x8f', params[3]!],
      [params[0]!, work.to, params[2]!, params[3]!],
      [params[0]!, params[1]!, params[2]!, { token: work.to }],
      paymasterParams({ ...operation(), paymaster: work.to }),
      paymasterParams({ ...operation(), callData: '0x1234' }),
      paymasterParams(operation([{ ...work, value: 1n }])),
    ])
      await expect(s.rpc('pm_getPaymasterStubData', altered)).rejects.toMatchObject({ code: 'refused' })
    await expect(
      testnetPaymasterRpc({ deployment: mainnet, node: s.chain.rpc })('pimlico_getTokenQuotes', []),
    ).rejects.toMatchObject({ code: 'refused' })
  })

  it('refuses missing/invalid signing secrets without leaking them, and an operation above the ceiling', async () => {
    for (const key of ['', 'unset', `0x${'00'.repeat(32)}`]) {
      const s = service({}, key)
      await expect(s.rpc('pm_getPaymasterData', paymasterParams())).rejects.toMatchObject({ code: 'unavailable' })
    }
    const s = service()
    await expect(
      s.rpc('pm_getPaymasterData', paymasterParams({ ...operation(), maxFeePerGas: 10n ** 18n })),
    ).rejects.toMatchObject({ code: 'ceiling' })
  })

  it('limits signing requests per sender before concurrent work can bypass the counter', async () => {
    const s = service()
    const requests = Array.from({ length: 13 }, () =>
      s.rpc('pm_getPaymasterData', [
        toBundlerJson({ ...operation(), sender: work.to }),
        charged.aa.entryPoint,
        '0x279f',
        { token: charged.aa.gasToken },
      ]),
    )
    const answers = await Promise.allSettled(requests)
    expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(12)
    expect(answers.filter((answer) => answer.status === 'rejected')).toHaveLength(1)
  })

  it('keeps stub limits measured even when zero is supplied, and refuses unsafe final limits and fee order', async () => {
    const s = service()
    const op = { ...operation(), paymasterVerificationGasLimit: 0n, paymasterPostOpGasLimit: 0n }
    expect(await s.rpc('pm_getPaymasterStubData', paymasterParams(op))).toMatchObject({
      paymasterPostOpGasLimit: '0x30d40',
      paymasterVerificationGasLimit: '0x186a0',
    })
    await expect(s.rpc('pm_getPaymasterData', paymasterParams(op))).rejects.toMatchObject({ code: 'refused' })
    await expect(
      s.rpc('pm_getPaymasterData', paymasterParams({ ...operation(), maxPriorityFeePerGas: 101_000_000_000n })),
    ).rejects.toMatchObject({ code: 'refused' })
  })
})
