import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, toHex } from 'viem'
import { type Json, executeCalldata, testnetFaucetAbi, toBundlerJson } from '@sidequest/sdk'
import { AA_BODY_LIMIT, aaRpc, aaRpcRoute } from '../src/aa-proxy.ts'
import { answering, mainnet, operation, sender, testnet, work } from './aa-fixtures.ts'

const key = 'unit-pimlico-key'
const bindings = { NETWORK: 'monad-mainnet', MONAD_RPC_URL: 'https://node.example/rpc', PIMLICO_API_KEY: key }
let ipSequence = 1
const request = (body: Json, ip = `192.0.2.${ipSequence++}`) =>
  new Request('https://api.example/aa/rpc', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const rpcBody = (method = 'eth_chainId', params: readonly Json[] = []) => ({ jsonrpc: '2.0', id: 7, method, params })
const sponsoredOp = () => {
  const { paymaster: _paymaster, ...op } = operation()
  return toBundlerJson({
    ...op,
    callData: executeCalldata([
      {
        to: testnet.testnetFaucet!,
        value: 0n,
        data: encodeFunctionData({ abi: testnetFaucetAbi, functionName: 'drip', args: [sender] }),
      },
    ]),
  })
}

afterEach(() => vi.useRealTimers())

describe('AA provider adapters', () => {
  it('routes node reads and bundler requests to their configured providers without exposing keys', async () => {
    const up = answering('0x8f')
    const rpc = aaRpc(bindings, up.fetcher)
    await rpc.node('eth_call', [])
    await rpc.bundler('eth_chainId', [])
    expect(up.calls[0]!.url).toBe(bindings.MONAD_RPC_URL)
    expect(up.calls[1]!.url).toContain('/v2/143/rpc?apikey=unit-pimlico-key')
    await expect(rpc.bundler('eth_sendTransaction', [])).rejects.toMatchObject({ code: 'refused' })
  })

  it('forces mainnet token quotes and paymaster context to configured Circle USDC', async () => {
    const up = answering({ paymaster: mainnet.aa.paymaster })
    const rpc = aaRpc(bindings, up.fetcher)
    await rpc.paymaster('pimlico_getTokenQuotes', [{ tokens: [work.to] }, mainnet.aa.entryPoint, '0x8f'])
    await rpc.paymaster('pm_getPaymasterData', [
      toBundlerJson(operation()),
      mainnet.aa.entryPoint,
      '0x8f',
      { token: work.to, extra: 'discarded' },
    ])
    expect(up.calls[0]!.params[0]).toEqual({ tokens: [mainnet.aa.gasToken] })
    expect(up.calls[1]!.params[3]).toEqual({ token: mainnet.aa.gasToken })
  })

  it('refuses mainnet sponsorship, chain mismatches and unsupported methods before contacting Pimlico', async () => {
    const up = answering(null)
    const rpc = aaRpc(bindings, up.fetcher)
    await expect(rpc.paymaster('pm_sponsorUserOperation', [])).rejects.toMatchObject({ code: 'refused' })
    await expect(
      rpc.paymaster('pm_getPaymasterStubData', [
        toBundlerJson(operation()),
        mainnet.aa.entryPoint,
        '0x8f',
        { sponsor: 'faucet' },
      ]),
    ).rejects.toMatchObject({ code: 'refused' })
    await expect(
      rpc.paymaster('pm_getPaymasterData', [toBundlerJson(operation()), mainnet.aa.entryPoint, '0x279f', {}]),
    ).rejects.toMatchObject({ code: 'refused' })
    expect(up.calls).toHaveLength(0)
  })

  it('sponsors only one testnet faucet drip and translates both ERC-7677 phases', async () => {
    const answer = {
      paymaster: work.to,
      paymasterData: '0xab',
      paymasterVerificationGasLimit: '0x100',
      paymasterPostOpGasLimit: '0x200',
    }
    const up = answering(answer)
    const rpc = aaRpc({ ...bindings, NETWORK: 'monad-testnet' }, up.fetcher)
    const params: Json[] = [sponsoredOp(), testnet.aa!.entryPoint, '0x279f', { sponsor: 'faucet' }]
    expect(await rpc.paymaster('pm_getPaymasterStubData', params)).toEqual(answer)
    expect(await rpc.paymaster('pm_getPaymasterData', params)).toEqual(answer)
    expect(up.calls.map((call) => call.method)).toEqual(['pm_sponsorUserOperation', 'pm_sponsorUserOperation'])
    expect(up.calls[0]!.params).toEqual(params.slice(0, 2))
  })

  it('refuses faucet sponsorship for extra calls, native value, wrong target, wrong method, unknown sponsor and factories', async () => {
    const up = answering(null)
    const rpc = aaRpc({ ...bindings, NETWORK: 'monad-testnet' }, up.fetcher)
    for (const callData of [
      executeCalldata([work]),
      executeCalldata([work, work]),
      executeCalldata([{ ...work, to: testnet.testnetFaucet!, value: 1n }]),
      executeCalldata([{ ...work, to: testnet.testnetFaucet! }]),
      '0xab',
    ]) {
      await expect(
        rpc.paymaster('pm_getPaymasterData', [
          { ...sponsoredOp(), callData },
          testnet.aa!.entryPoint,
          '0x279f',
          { sponsor: 'faucet' },
        ]),
      ).rejects.toBeDefined()
    }
    await expect(
      rpc.paymaster('pm_getPaymasterData', [sponsoredOp(), testnet.aa!.entryPoint, '0x279f', { sponsor: 'anything' }]),
    ).rejects.toMatchObject({ code: 'refused' })
    await expect(
      rpc.paymaster('pm_getPaymasterData', [
        { ...sponsoredOp(), factory: work.to },
        testnet.aa!.entryPoint,
        '0x279f',
        { sponsor: 'faucet' },
      ]),
    ).rejects.toMatchObject({ code: 'refused' })
    expect(up.calls).toHaveLength(0)
  })

  it('returns unavailable when a required provider secret or testnet paymaster configuration is absent', async () => {
    const up = answering(null)
    for (const missing of [undefined, '', 'unset'])
      await expect(
        aaRpc({ ...bindings, PIMLICO_API_KEY: missing }, up.fetcher).bundler('eth_chainId', []),
      ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      aaRpc({ ...bindings, NETWORK: 'monad-testnet', MONAD_RPC_URL: undefined }, up.fetcher).paymaster(
        'pimlico_getTokenQuotes',
        [{ tokens: [testnet.aa!.gasToken] }, testnet.aa!.entryPoint, toHex(testnet.chainId)],
      ),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(up.calls).toHaveLength(0)
  })
})

describe('public POST /aa/rpc', () => {
  it('returns a JSON-RPC 2.0 result with the request id and the supplied API CORS policy', async () => {
    const up = answering('0x8f')
    const response = await aaRpcRoute(
      request(rpcBody()),
      bindings,
      { 'access-control-allow-origin': 'https://api.example' },
      up.fetcher,
    )
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: '0x8f' })
    expect(response.headers.get('access-control-allow-origin')).toBe('https://api.example')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const preflight = await aaRpcRoute(
      new Request('https://api.example/aa/rpc', { method: 'OPTIONS' }),
      bindings,
      {},
      up.fetcher,
    )
    expect(preflight.status).toBe(204)
  })

  it('rejects non-POST, JSON-RPC batches, notifications, bad version/id/params and methods outside the allowlist', async () => {
    const up = answering(null)
    expect((await aaRpcRoute(new Request('https://api.example/aa/rpc'), bindings, {}, up.fetcher)).status).toBe(405)
    for (const body of [
      [],
      { jsonrpc: '2.0', method: 'eth_chainId', params: [] },
      { ...rpcBody(), jsonrpc: '1.0' },
      { ...rpcBody(), id: {} },
      { ...rpcBody(), params: {} },
      rpcBody('pm_sponsorUserOperation'),
      rpcBody('eth_call'),
      rpcBody('eth_sendRawTransaction'),
    ]) {
      const response = await aaRpcRoute(request(body), bindings, {}, up.fetcher)
      expect(await response.json()).toHaveProperty('error.code')
    }
    expect(up.calls).toHaveLength(0)
  })

  it('bounds chunked request bodies and never forwards oversized or invalid JSON', async () => {
    const up = answering(null)
    const tooLarge = request({ ...rpcBody(), padding: 'x'.repeat(AA_BODY_LIMIT) })
    expect(await (await aaRpcRoute(tooLarge, bindings, {}, up.fetcher)).json()).toHaveProperty(
      'error.message',
      'JSON-RPC body too large',
    )
    const malformed = new Request('https://api.example/aa/rpc', {
      method: 'POST',
      headers: { 'cf-connecting-ip': `192.0.2.${ipSequence++}` },
      body: '{',
    })
    expect(await (await aaRpcRoute(malformed, bindings, {}, up.fetcher)).json()).toHaveProperty('error.code', -32700)
    expect(up.calls).toHaveLength(0)
  })

  it('reduces provider errors to a numeric code and bounded message, discarding keys, URLs and error data', async () => {
    const up = answering(
      { code: -32501, message: `${key} https://upstream.example/${key}`, data: { secret: key } },
      true,
    )
    const response = await aaRpcRoute(request(rpcBody()), bindings, {}, up.fetcher)
    const text = await response.text()
    expect(text).not.toContain(key)
    expect(text).not.toContain('upstream.example')
    expect(JSON.parse(text)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32501, message: 'AA provider refused the request', data: { code: 'refused' } },
    })
  })

  it('limits canonical hashed client IPs per isolate and allows them again after the minute', async () => {
    const up = answering(null)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T22:00:00Z'))
    for (let i = 0; i < 60; i++) {
      const ip = i % 2 === 0 ? '2001:db8::1' : '2001:db8:0:0:0:0:0:1'
      expect((await aaRpcRoute(request(rpcBody(), ip), bindings, {}, up.fetcher)).status).toBe(200)
    }
    expect((await aaRpcRoute(request(rpcBody(), '2001:db8::1'), bindings, {}, up.fetcher)).status).toBe(429)
    vi.advanceTimersByTime(60_000)
    expect((await aaRpcRoute(request(rpcBody(), '2001:db8::1'), bindings, {}, up.fetcher)).status).toBe(200)
  })
})
