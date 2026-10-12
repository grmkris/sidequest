import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { type Address, type Hex, decodeFunctionData, isAddress, isHex, parseUnits } from 'viem'
import type { WalletStep } from './components/txOperation.ts'

const AddressText = Schema.String.pipe(Schema.refine((value): value is Address => isAddress(value)))
const HexText = Schema.String.pipe(Schema.refine((value): value is Hex => isHex(value, { strict: true })))
const HashText = HexText.pipe(Schema.check(Schema.makeFilter((value) => value.length === 66)))
const Step = Schema.Struct({
  to: AddressText,
  data: HexText,
  value: Schema.Literal('0'),
  chainId: Schema.Number,
  description: Schema.String,
})
const Prepared = Schema.Struct({
  hash: HashText,
  grant: Schema.Unknown,
  description: Schema.Struct({ validAfter: Schema.Number }),
  previous: Schema.Array(HashText),
  transactions: Schema.Array(Step),
})
const Revoked = Schema.Struct({
  hash: HashText,
  status: Schema.Literals(['revoked', 'disabled']),
  transactions: Schema.Array(Step),
})
const Intent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('grant'), key: Schema.String, amount: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('revoke'), hash: HashText }),
])
export type GasBudgetIntent = Schema.Schema.Type<typeof Intent>
export type PreparedGasBudget = Schema.Schema.Type<typeof Prepared>
export const parseGasBudgetIntent = Schema.decodeUnknownSync(Intent)
export const readPreparedGasBudget = Schema.decodeUnknownSync(Prepared)
export const readRevokedGasBudget = Schema.decodeUnknownSync(Revoked)

export function gasBudgetAmount(amount = '5'): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) throw new Error('Enter a positive USDC amount with at most 6 decimals.')
  const units = parseUnits(amount, 6)
  if (units <= 0n || units >= 1n << 256n) throw new Error('Enter a positive USDC amount.')
  return units
}

export function readGasBudgetIntent(storage: Pick<Storage, 'getItem'>, key: string): GasBudgetIntent | null {
  const saved = storage.getItem(key)
  return saved === null ? null : parseGasBudgetIntent(JSON.parse(saved))
}
export function writeGasBudgetIntent(
  storage: Pick<Storage, 'setItem' | 'getItem' | 'removeItem'>,
  key: string,
  intent: GasBudgetIntent | null,
) {
  if (intent === null) {
    storage.removeItem(key)
    return
  }
  const saved = JSON.stringify(intent)
  storage.setItem(key, saved)
  if (storage.getItem(key) !== saved) throw new Error('The gas budget journal is unavailable. Nothing may start.')
}

/** Reconstruct the exact gas grant locally, including token, recipient, amount, period, start and expiry. */
export function reviewGasBudget(input: {
  deployment: sdk.Deployment
  prepared: PreparedGasBudget
  operator: Address
  agent: Address
  amount: bigint
  now?: number
}) {
  const { deployment, prepared, operator, agent, amount, now = Math.floor(Date.now() / 1000) } = input
  if (deployment.aa === null) throw new Error('USDC gas is not configured.')
  const grant = sdk.parseDelegation(JSON.stringify(prepared.grant))
  const spec: sdk.GrantSpec = {
    kind: 'gas-allowance',
    delegator: operator,
    agent,
    token: deployment.aa.gasToken,
    amount,
    periodSeconds: sdk.ALLOWANCE_PERIOD,
    salt: grant.salt,
    start: prepared.description.validAfter,
  }
  sdk.assertGrant({ deployment, stack: deployment.stacks.main! }, spec, grant)
  if (sdk.delegationHash(grant) !== prepared.hash || spec.start > now + 60 || sdk.grantExpiry(spec) <= now)
    throw new Error('The gas budget differs from the review, or expired.')
  return { hash: prepared.hash, typedData: sdk.delegationTypedData(deployment, grant) }
}

/** Every disable must name a previous hash owned by this operator on the configured chain. */
export function gasBudgetDisables(
  deployment: sdk.Deployment,
  operator: Address,
  hashes: readonly Hex[],
  txs: readonly WalletStep[],
): WalletStep[] {
  const seen = new Set<Hex>()
  for (const tx of txs) {
    if (
      tx.chainId !== deployment.chainId ||
      tx.value !== '0' ||
      tx.to.toLowerCase() !== deployment.delegation.manager.toLowerCase()
    )
      throw new Error('The gas-budget disable uses another network or target.')
    const decoded = decodeFunctionData({ abi: sdk.delegationManagerAbi, data: tx.data })
    if (decoded.functionName !== 'disableDelegation') throw new Error('Expected a permission disable only.')
    const grant = decoded.args[0]
    const hash = sdk.delegationHash(grant)
    if (grant.delegator.toLowerCase() !== operator.toLowerCase() || !hashes.includes(hash) || seen.has(hash))
      throw new Error('The gas-budget disable differs from the previous operator permission.')
    seen.add(hash)
  }
  if (seen.size !== hashes.length) throw new Error('A previous gas-budget disable is missing.')
  return [...txs]
}
