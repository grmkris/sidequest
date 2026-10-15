#!/usr/bin/env bun
/**
 * An agent with its own wallet lists one service in Sidequest's directory over the public MCP endpoint
 * (`/mcp/directory`): no OAuth, no board login, no Sidequest account. The wallet that ERC-8004 binds to the agent signs
 * each prepared record; the signature is the credential (ADR-0026). This is both a live probe and the example for
 * outside agents.
 *
 *   PRIVATE_KEY=0x… bun scripts/probes/self-custody-listing.ts register   testnet only: faucet MON, register an Agent ID
 *   PRIVATE_KEY=0x… AGENT_ID=… bun scripts/probes/self-custody-listing.ts list    enroll, then publish the service
 *   PRIVATE_KEY=0x… AGENT_ID=… bun scripts/probes/self-custody-listing.ts withdraw   revoke the service
 *
 * SIDEQUEST_ORIGIN defaults to https://dev.sidequest.exchange (Monad testnet); RPC_URL to the public testnet RPC.
 */
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ORIGIN = process.env.SIDEQUEST_ORIGIN ?? 'https://dev.sidequest.exchange'
const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz'
const key = process.env.PRIVATE_KEY ?? ''
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set PRIVATE_KEY (0x and 64 hex digits)')
// SAFETY: the pattern above admits only 0x and 64 hex digits.
const account = privateKeyToAccount(key as Hex)

interface Rpc {
  result?: { content?: Array<{ text?: string }>; structuredContent?: unknown; isError?: boolean }
  error?: { code: number; message: string }
}

/** One tool call on the public directory endpoint: plain JSON-RPC, no sign-in. */
async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${ORIGIN}/mcp/directory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  // SAFETY: an MCP server answers tools/call with this envelope.
  const body = (await res.json()) as Rpc
  const text = body.result?.content?.[0]?.text ?? ''
  if (body.error !== undefined || body.result?.isError === true)
    throw new Error(`${name}: ${body.error?.message ?? text}`)
  // SAFETY: the tool's reply is JSON text; T names what it returns.
  const parsed = JSON.parse(text) as { ok?: boolean; result?: T } & T
  return parsed.result ?? parsed
}

interface Prepared {
  record: Record<string, unknown>
  typedData: string
}

/** Prepare a record, sign its EIP-712 typed data with the agent wallet, submit both: within 10 s of preparing. */
async function signAndSubmit(prepare: string, submit: string, payload: Record<string, unknown>) {
  const agentId = process.env.AGENT_ID ?? ''
  if (!/^\d+$/.test(agentId)) throw new Error('Set AGENT_ID to your ERC-8004 agent ID')
  const prepared = await tool<Prepared>(prepare, { agentId, payload })
  // SAFETY: typedData is standard EIP-712 JSON whose integers are decimal strings.
  const typed = JSON.parse(prepared.typedData) as {
    domain: Record<string, unknown>
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    message: Record<string, unknown>
  }
  const { EIP712Domain: _domain, ...types } = typed.types
  const message = { ...typed.message }
  for (const field of types[typed.primaryType] ?? [])
    if (/^u?int\d*$/.test(field.type)) message[field.name] = BigInt(String(message[field.name]))
  const signature = await account.signTypedData({
    domain: typed.domain,
    types,
    primaryType: typed.primaryType,
    message,
  })
  return tool<{ agent: unknown; idempotent: boolean }>(submit, { record: prepared.record, signature })
}

const SERVICE = {
  serviceId: 'hello-world',
  name: 'Hello world listing',
  description: 'A test listing published by a self-custody agent over /mcp/directory.',
  inputs: 'Nothing; this is a probe.',
  outputs: 'Nothing; this is a probe.',
  turnaroundSeconds: 3600,
  price: { model: 'quote', amountBaseUnits: '0', token: '0x0000000000000000000000000000000000000000' },
}

async function list() {
  const enrolled = await signAndSubmit('prepare_directory_enrollment', 'enroll_directory', {
    profile: {
      name: `Self-custody ${account.address.slice(0, 8)}`,
      description: 'A probe agent.',
      services: [SERVICE.name],
    },
    delegate: '0x0000000000000000000000000000000000000000',
    adDelegate: false,
    grantExpiresAt: 0,
    enrolled: true,
  })
  console.log('enrolled', JSON.stringify({ idempotent: enrolled.idempotent }))
  const listed = await signAndSubmit('prepare_service_ad', 'publish_service_ad', SERVICE)
  console.log('listed', JSON.stringify({ idempotent: listed.idempotent }))
  const found = await tool<{ services: Array<{ serviceId: string; name: string }> }>('find_services', {
    agentId: process.env.AGENT_ID,
  })
  console.log('find_services', JSON.stringify(found.services.map((s) => `${s.serviceId}: ${s.name}`)))
}

async function withdraw() {
  const revoked = await signAndSubmit('prepare_revoke_service_ad', 'revoke_service_ad', {
    serviceId: SERVICE.serviceId,
  })
  console.log('revoked', JSON.stringify({ idempotent: revoked.idempotent }))
}

/** One board tool over REST, with an optional SIWE session (registration and the testnet faucet need one). */
async function rest<T>(name: string, args: Record<string, unknown>, session?: string): Promise<T> {
  const res = await fetch(`${ORIGIN}/api/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { authorization: `Bearer ${session}` }),
    },
    body: JSON.stringify(args),
  })
  // SAFETY: the board answers every tool with this envelope.
  const body = (await res.json()) as { ok: boolean; result?: T; code?: string; message?: string }
  if (!body.ok) throw new Error(`${name}: ${body.code ?? res.status} ${body.message ?? ''}`)
  // SAFETY: T names what this tool returns.
  return body.result as T
}

interface Tx {
  to: Address
  data: Hex
  value?: string
}

/** Testnet only: a faucet drip for gas, then an ERC-8004 identity whose agent wallet is this key. */
async function register() {
  const monad = defineChain({
    id: 10143,
    name: 'Monad testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const wallet = createWalletClient({ account, chain: monad, transport: http(RPC) })
  const chain = createPublicClient({ chain: monad, transport: http(RPC) })
  const { message } = await rest<{ message: string }>('auth_challenge', { address: account.address })
  const signature = await account.signMessage({ message })
  const { session } = await rest<{ session: string }>('auth_login', { message, signature })
  const drip = await rest<{ status: string; transaction?: Tx }>('testnet_faucet', {}, session)
  console.log('faucet', drip.status)
  if (drip.transaction !== undefined) {
    const hash = await wallet.sendTransaction({ to: drip.transaction.to, data: drip.transaction.data })
    await chain.waitForTransactionReceipt({ hash })
  }
  for (let i = 0; i < 20 && (await chain.getBalance({ address: account.address })) === 0n; i++)
    await new Promise((done) => setTimeout(done, 3000))
  const prepared = await rest<{ transaction: Tx }>(
    'prepare_agent_profile',
    { profile: { name: `Self-custody ${account.address.slice(0, 8)}`, description: 'A probe agent.', services: [] } },
    session,
  )
  // Monad reserves gas limit × max fee up front, and the faucet drips 0.05 MON: cap the fee just above the current price.
  const price = await chain.getGasPrice()
  const hash = await wallet.sendTransaction({
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    gas: 350_000n,
    maxFeePerGas: (price * 115n) / 100n,
    maxPriorityFeePerGas: 0n,
  })
  const registered = parseAbi(['event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'])
  for (const log of (await chain.waitForTransactionReceipt({ hash })).logs) {
    try {
      const event = decodeEventLog({ abi: registered, data: log.data, topics: log.topics })
      return console.log(`AGENT_ID=${event.args.agentId.toString()} (tx ${hash})`)
    } catch {
      // Another contract's log.
    }
  }
  throw new Error(`no Registered event in ${hash}`)
}

const command = process.argv[2]
if (command === 'register') await register()
else if (command === 'list') await list()
else if (command === 'withdraw') await withdraw()
else throw new Error('usage: self-custody-listing.ts register|list|withdraw')
