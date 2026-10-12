/**
 * Live probe for ADR-0023 on Monad testnet: a throwaway key upgrades itself to the DeleGator inside its first user
 * operation (`eip7702Auth`) and approves nothing of value (USDC `approve(dead, 0)`), with Pimlico's sponsoring
 * paymaster paying the gas, so it needs no funds. It proves the bundler takes DeleGator user operations with a 7702
 * authorization here, that our hash matches the bundler's and that the account's code points at the DeleGator after.
 *
 *   PIMLICO_API_KEY=… bun --no-env-file packages/sdk/scripts/live/aa-probe.ts
 *
 * First run, 12 Oct 2026: userOp 0xceec3be93f5adae95aed45adfe6cb6a0a286bb9883267b31eb5649efc0683600 in tx
 * 0x77676b17a5e028b76f02ba303fcd340247aed18a73ee287e5c49a3768969db4a, 0.0395 MON of gas sponsored.
 */
import { type Address, createPublicClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  ESTIMATE_SIGNATURE,
  approveCall,
  delegatorTypedData,
  deployment,
  executeCalldata,
  jsonRpc,
  laneNonce,
  nonceKey,
} from '../../src/index.ts'
import { type UserOperation, toBundlerJson, userOpHash } from '../../src/aa/userop.ts'
import { field, hexField, quantity } from '../../src/aa/rpc.ts'

const DEAD: Address = '0x000000000000000000000000000000000000dEaD'

const d = deployment('monad-testnet')
const aa = d.aa
if (aa === null) throw new Error('no accountAbstraction config')
const apiKey = process.env.PIMLICO_API_KEY ?? ''
if (apiKey === '') throw new Error('set PIMLICO_API_KEY')
const pimlico = jsonRpc(`https://api.pimlico.io/v2/${d.chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`, 'Pimlico')
const node = createPublicClient({ transport: http('https://testnet-rpc.monad.xyz') })
const owner = privateKeyToAccount(generatePrivateKey())

const signed = await owner.signAuthorization({
  contractAddress: d.delegation.delegator,
  chainId: d.chainId,
  nonce: await node.getTransactionCount({ address: owner.address }),
})
const auth = { ...signed, address: d.delegation.delegator, yParity: signed.yParity ?? 0 }
const fast = field(await pimlico('pimlico_getUserOperationGasPrice', []), 'fast')
const draft: UserOperation = {
  sender: owner.address,
  nonce: laneNonce(nonceKey('aa-probe')),
  callData: executeCalldata([approveCall(aa.gasToken, DEAD, 0n)]),
  callGasLimit: 0n,
  verificationGasLimit: 0n,
  preVerificationGas: 0n,
  maxFeePerGas: quantity(field(fast, 'maxFeePerGas'), 'max fee'),
  maxPriorityFeePerGas: quantity(field(fast, 'maxPriorityFeePerGas'), 'priority fee'),
  signature: ESTIMATE_SIGNATURE,
}
// One call: Pimlico estimates and sponsors through its verifying paymaster, returning every limit and the data.
const s = await pimlico('pm_sponsorUserOperation', [toBundlerJson(draft, auth), aa.entryPoint])
const sponsored: UserOperation = {
  ...draft,
  callGasLimit: quantity(field(s, 'callGasLimit'), 'call gas'),
  verificationGasLimit: quantity(field(s, 'verificationGasLimit'), 'verification gas'),
  preVerificationGas: quantity(field(s, 'preVerificationGas'), 'pre-verification gas'),
  paymaster: hexField(field(s, 'paymaster'), 'paymaster'),
  paymasterData: hexField(field(s, 'paymasterData'), 'paymaster data'),
  paymasterVerificationGasLimit: quantity(field(s, 'paymasterVerificationGasLimit'), 'paymaster gas'),
  paymasterPostOpGasLimit: quantity(field(s, 'paymasterPostOpGasLimit'), 'paymaster post-op gas'),
}
const op = {
  ...sponsored,
  signature: await owner.signTypedData(delegatorTypedData(sponsored, d.chainId, aa.entryPoint)),
}
const hash = hexField(await pimlico('eth_sendUserOperation', [toBundlerJson(op, auth), aa.entryPoint]), 'hash')
console.log(`sent ${hash}; ours ${userOpHash(op, d.chainId, aa.entryPoint)}`)
for (let attempt = 0; attempt < 40; attempt++) {
  const receipt = await pimlico('eth_getUserOperationReceipt', [hash])
  if (receipt !== null) {
    const tx = hexField(field(field(receipt, 'receipt'), 'transactionHash'), 'tx')
    const cost = quantity(field(receipt, 'actualGasCost'), 'cost')
    console.log(`landed ${tx}: success ${String(field(receipt, 'success') === true)}, gas ${cost} wei`)
    console.log(`code ${await node.getCode({ address: owner.address })}`)
    process.exit(field(receipt, 'success') === true ? 0 : 1)
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
}
console.log('no receipt within 60 s')
process.exit(2)
