import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { zeroHash, type Address } from 'viem'
import * as sdk from '@sidequest/sdk'

export const MINING_PRICE_BODY_LIMIT = 64 * 1024
const NAME = /^(?:prices|previous-prices|pending-epoch|pending-state|epoch|state)-\d+\.json$/

type MiningClient = Pick<sdk.Ctx['publicClient'], 'getBlock' | 'readContract'>
type SignedPrices = ReturnType<typeof sdk.parseSignedPriceList>

export interface MiningBucket {
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(key: string, value: string): Promise<object | void>
}

export interface MiningReply {
  status: number
  body: { ok: false; code: string; error: string } | { ok: true; epoch: string; signer: Address; keys: string[] }
}

export interface PriceUpload {
  body: string
  stage: string
  deployment: sdk.Deployment
  client?: MiningClient | undefined
  bucket?: MiningBucket | undefined
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseUpload(text: string) {
  try {
    const body: unknown = JSON.parse(text)
    if (!isRecord(body) || !('prices' in body)) throw new Error('missing prices')
    const prices = sdk.parseSignedPriceList(body.prices)
    const previous = 'previous' in body ? sdk.parseSignedPriceList(body.previous) : undefined
    if (previous !== undefined) {
      if (previous.prices.epoch !== prices.prices.epoch - 1n)
        throw new Refusal(400, 'previous-epoch', 'The previous list must name the preceding epoch')
      if (previous.prices.factoryUsdPrice !== prices.prices.factoryUsdPrice)
        throw new Refusal(400, 'previous-price', 'The previous list must have the same SIDE price')
    }
    return { prices, previous }
  } catch (error) {
    if (error instanceof Refusal) throw error
    throw new Refusal(400, 'invalid-shape', 'The upload needs valid signed price lists')
  }
}

async function chainFacts(client: MiningClient, sidequest: sdk.SidequestDeployment, epoch: bigint) {
  try {
    const head = await client.getBlock({ blockTag: 'latest' })
    const [end, root, owners] = await Promise.all([
      client.readContract({
        address: sidequest.distributor,
        abi: sdk.epochDistributorAbi,
        functionName: 'epochEnd',
        args: [epoch],
        blockNumber: head.number,
      }),
      client.readContract({
        address: sidequest.distributor,
        abi: sdk.epochDistributorAbi,
        functionName: 'rootOf',
        args: [epoch],
        blockNumber: head.number,
      }),
      client.readContract({
        address: sidequest.safe,
        abi: sdk.safeGetOwnersAbi,
        functionName: 'getOwners',
        blockNumber: head.number,
      }),
    ])
    return {
      end,
      root,
      owners,
      timestamp: head.timestamp,
    }
  } catch {
    throw new Refusal(503, 'rpc-unavailable', 'The chain is unavailable')
  }
}

async function verifyOwner(
  signed: SignedPrices,
  chainId: number,
  sidequest: sdk.SidequestDeployment,
  owners: readonly Address[],
) {
  let signer: Address
  try {
    signer = await sdk.recoverPriceListSigner(signed.prices, signed.file.signature, chainId, sidequest.distributor)
  } catch {
    throw new Refusal(403, 'invalid-signature', 'The price list signature is invalid')
  }
  if (signer !== signed.file.signer.toLowerCase())
    throw new Refusal(403, 'invalid-signature', 'The signature does not match the signer on this deployment')
  if (!owners.some((owner) => owner.toLowerCase() === signer))
    throw new Refusal(403, 'not-owner', 'The price list signer is not a current Safe owner')
  return signer
}

async function storePrices(bucket: MiningBucket | undefined, prices: SignedPrices, previous: SignedPrices | undefined) {
  if (bucket === undefined) throw new Refusal(503, 'storage-unavailable', 'The mining manifest store is unavailable')
  const epoch = prices.prices.epoch
  const writes: Array<[string, unknown]> = [[`mining/prices-${epoch}.json`, prices.file]]
  if (previous !== undefined) writes.push([`mining/previous-prices-${epoch}.json`, previous.file])
  try {
    for (const [key, file] of writes) {
      const bytes = `${JSON.stringify(file, null, 2)}\n`
      await bucket.put(key, bytes)
      const object = await bucket.get(key)
      if (object === null || (await object.text()) !== bytes) throw new Error('readback')
    }
  } catch {
    throw new Refusal(503, 'storage-unavailable', 'The mining manifest readback failed')
  }
  return writes.map(([key]) => key)
}

async function uploadPrices(input: PriceUpload): Promise<MiningReply> {
  if (input.stage !== 'dev' && input.stage !== 'local')
    throw new Refusal(403, 'pipeline-off', 'Mining price upload is disabled on this stage')
  if (new TextEncoder().encode(input.body).byteLength > MINING_PRICE_BODY_LIMIT)
    throw new Refusal(413, 'body-too-large', 'Mining price upload is at most 64 KiB')
  const { prices, previous } = parseUpload(input.body)
  if (input.client === undefined || input.deployment.sidequest === null)
    throw new Refusal(503, 'rpc-unavailable', 'The chain is unavailable')
  const sidequest = input.deployment.sidequest
  const facts = await chainFacts(input.client, sidequest, prices.prices.epoch)
  const signer = await verifyOwner(prices, input.deployment.chainId, sidequest, facts.owners)
  if (facts.end > facts.timestamp) throw new Refusal(409, 'epoch-not-ended', 'The mining epoch has not ended')
  if (facts.root.dataHash !== zeroHash) throw new Refusal(409, 'already-rooted', 'The epoch already has a root')
  if (previous !== undefined) await verifyOwner(previous, input.deployment.chainId, sidequest, facts.owners)
  const keys = await storePrices(input.bucket, prices, previous)
  return { status: 200, body: { ok: true, epoch: prices.prices.epoch.toString(), signer, keys } }
}

export async function postMiningPrices(input: PriceUpload): Promise<MiningReply> {
  try {
    return await uploadPrices(input)
  } catch (error) {
    const refusal =
      error instanceof Refusal ? error : new Refusal(503, 'storage-unavailable', 'Mining price upload is unavailable')
    return { status: refusal.status, body: { ok: false, code: refusal.code, error: refusal.message } }
  }
}

export async function miningFileResponse(bucket: MiningBucket | undefined, name: string) {
  const headers = { 'cache-control': 'no-store' }
  if (!NAME.test(name)) return HttpServerResponse.text('bad mining file name', { status: 400, headers })
  const object = await bucket?.get(`mining/${name}`)
  if (object == null) return HttpServerResponse.text('not found', { status: 404, headers })
  return HttpServerResponse.uint8Array(new Uint8Array(await object.arrayBuffer()), {
    contentType: 'application/json',
    headers,
  })
}

async function boundedBody(request: Request) {
  if (Number(request.headers.get('content-length')) > MINING_PRICE_BODY_LIMIT)
    throw new Refusal(413, 'body-too-large', 'Mining price upload is at most 64 KiB')
  const reader = request.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      size += chunk.value.byteLength
      if (size > MINING_PRICE_BODY_LIMIT) {
        await reader.cancel()
        throw new Refusal(413, 'body-too-large', 'Mining price upload is at most 64 KiB')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/** The real Worker and local workerd probe share this bounded HTTP boundary. */
export async function miningRoute(request: Request, path: string, input: Omit<PriceUpload, 'body'>) {
  if (request.method === 'GET') return miningFileResponse(input.bucket, path.slice('/data/mining/'.length))
  const headers = { 'cache-control': 'no-store' }
  if (request.method !== 'POST' || path !== '/data/mining/prices')
    return HttpServerResponse.text('method not allowed', { status: 405, headers })
  let reply: MiningReply
  try {
    if (input.stage !== 'dev' && input.stage !== 'local')
      throw new Refusal(403, 'pipeline-off', 'Mining price upload is disabled on this stage')
    reply = await postMiningPrices({ ...input, body: await boundedBody(request) })
  } catch (error) {
    const refusal =
      error instanceof Refusal ? error : new Refusal(400, 'invalid-shape', 'The upload body could not be read')
    reply = { status: refusal.status, body: { ok: false, code: refusal.code, error: refusal.message } }
  }
  return HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status, headers })
}
