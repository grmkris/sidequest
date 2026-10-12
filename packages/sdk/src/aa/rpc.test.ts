import { describe, expect, it } from 'vitest'
import { jsonRpc, pimlicoUrl } from './rpc.ts'

const answering = (body: string, status = 200): typeof fetch =>
  Object.assign(async () => new Response(body, { status }), { preconnect: () => undefined })
const silentFetch: typeof fetch = Object.assign(
  async () => {
    throw new TypeError('network down')
  },
  { preconnect: () => undefined },
)

describe('JSON-RPC to the bundler and paymaster', () => {
  it('returns the result, and an error object as a refusal with its message', async () => {
    expect(await jsonRpc('https://b.example', 'bundler', answering('{"result":"0x2a"}'))('eth_chainId', [])).toBe(
      '0x2a',
    )
    await expect(
      jsonRpc(
        'https://b.example',
        'bundler',
        answering('{"error":{"message":"AA21 prefund"}}'),
      )('eth_sendUserOperation', []),
    ).rejects.toMatchObject({ code: 'refused', message: 'bundler refused eth_sendUserOperation: AA21 prefund' })
  })

  it('reads no answer, HTML and HTTP errors as unavailable, naming the service instead of the URL', async () => {
    const url = pimlicoUrl(10143, 'secret-key')
    await expect(jsonRpc(url, 'Pimlico', silentFetch)('eth_chainId', [])).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Pimlico did not answer eth_chainId',
    })
    await expect(jsonRpc(url, 'Pimlico', answering('<html>', 502))('eth_chainId', [])).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(jsonRpc(url, 'Pimlico', answering('{}', 503))('eth_chainId', [])).rejects.not.toThrow('secret-key')
  })

  it('keeps proxy transport failures unavailable, so an unanswered browser send reconciles as uncertain', async () => {
    const response =
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"AA unavailable","data":{"code":"unavailable"}}}'
    await expect(
      jsonRpc('https://api.example/aa/rpc', 'AA proxy', answering(response, 503))('eth_sendUserOperation', []),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
})
