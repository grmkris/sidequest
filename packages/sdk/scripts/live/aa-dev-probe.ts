/**
 * Live probe of a stage's `/aa/rpc` proxy (ADR-0023), as the browser uses it: no Pimlico key, no relay.
 *
 *   bun --no-env-file packages/sdk/scripts/live/aa-dev-probe.ts [origin] [charged <privateKeyFile>]
 *
 * By default a fresh throwaway key that holds nothing at all claims from the testnet faucet in one user operation. It
 * upgrades itself to the DeleGator in the same operation (`eip7702Auth`), and Pimlico sponsors the gas through the
 * proxy's faucet route. The probe prints the operation, its bundle transaction and the SIDE the account received.
 *
 * `charged <file>` reads a hex key from <file> (fund its address with a little Circle testnet USDC first). The same
 * claim then pays its gas in USDC through our testnet paymaster: quote, standing approval, signed quote, postOp charge.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, encodeFunctionData, erc20Abi, http, isHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  buildUserOp,
  delegatorTypedData,
  deployment,
  jsonRpc,
  nonceKey,
  sendUserOp,
  testnetFaucetAbi,
  userOpReceipt,
} from '../../src/index.ts'

const origin = process.argv[2] ?? 'https://dev.sidequest.exchange'
const d = deployment('monad-testnet')
const aa = d.aa
if (aa === null || d.testnetFaucet === null) throw new Error('no accountAbstraction or faucet config')
const faucet = d.testnetFaucet
const proxy = jsonRpc(`${origin}/aa/rpc`, 'aa proxy')
const node = jsonRpc('https://testnet-rpc.monad.xyz', 'Monad testnet')
const client = createPublicClient({ transport: http('https://testnet-rpc.monad.xyz') })
const charged = process.argv[3] === 'charged'
const keyFile = charged ? readFileSync(process.argv[4] ?? '', 'utf8').trim() : ''
if (charged && !isHex(keyFile, { strict: true })) throw new Error('charged needs a file holding a hex private key')
const owner = privateKeyToAccount(isHex(keyFile, { strict: true }) ? keyFile : generatePrivateKey())
console.log(`fresh account ${owner.address}, MON ${await client.getBalance({ address: owner.address })}`)

const usdc = (address: `0x${string}`) =>
  client.readContract({ address: aa.gasToken, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
if (charged) console.log(`USDC ${await usdc(owner.address)}`)
const code = await client.getCode({ address: owner.address })
const signed =
  code === undefined || code === '0x'
    ? await owner.signAuthorization({
        contractAddress: d.delegation.delegator,
        chainId: d.chainId,
        nonce: await client.getTransactionCount({ address: owner.address }),
      })
    : undefined
const authorization =
  signed === undefined ? undefined : { ...signed, address: d.delegation.delegator, yParity: signed.yParity ?? 0 }
const built = await buildUserOp({
  aa,
  chainId: d.chainId,
  node,
  bundler: proxy,
  paymaster: proxy,
  sender: owner.address,
  calls: () => [
    {
      to: faucet,
      value: 0n,
      data: encodeFunctionData({ abi: testnetFaucetAbi, functionName: 'drip', args: [owner.address] }),
    },
  ],
  nonceKey: nonceKey(`aa-dev-probe-${charged ? 'charged' : 'sponsored'}-${owner.address}-${Date.now()}`),
  authorization,
  ...(charged ? {} : { sponsor: 'faucet' as const }),
})
console.log(
  `built: paymaster ${built.op.paymaster}, call gas ${built.op.callGasLimit}, pre-verification gas ${built.op.preVerificationGas}, max cost ${built.maxCost}, hash ${built.userOpHash}`,
)
const signature = await owner.signTypedData(delegatorTypedData(built.op, d.chainId, aa.entryPoint))
const hash = await sendUserOp(proxy, built, signature)
console.log(`sent ${hash}`)
for (let attempt = 0; attempt < 40; attempt++) {
  const receipt = await userOpReceipt(proxy, hash)
  if (receipt !== null) {
    const side = await client.readContract({
      address: d.factory,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner.address],
    })
    console.log(
      `landed ${receipt.txHash}: ${receipt.status}; SIDE ${side}; code ${await client.getCode({ address: owner.address })}`,
    )
    if (charged) console.log(`USDC after ${await usdc(owner.address)} (gas ${receipt.actualGasCost} wei)`)
    process.exit(receipt.status === 'success' ? 0 : 1)
  }
  await new Promise((done) => setTimeout(done, 1500))
}
console.log('no receipt within 60 s')
process.exit(2)
