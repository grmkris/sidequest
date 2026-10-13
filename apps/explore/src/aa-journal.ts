import { Schema } from 'effect'
import * as sdk from '@sidequest/sdk'
import { type Hex, isHex } from 'viem'

const HexValue = Schema.String.pipe(Schema.refine((value): value is Hex => isHex(value, { strict: true })))
const AddressValue = HexValue.pipe(Schema.check(Schema.makeFilter((value) => value.length === 42)))
const HashValue = HexValue.pipe(Schema.check(Schema.makeFilter((value) => value.length === 66)))
const Quantity = HexValue.pipe(Schema.check(Schema.makeFilter((value) => value.length > 2)))
const Natural = Schema.Number.pipe(
  Schema.check(Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0)),
)
const Authorization = Schema.Struct({
  address: AddressValue,
  chainId: Quantity,
  nonce: Quantity,
  r: HashValue,
  s: HashValue,
  yParity: Quantity,
})
const StoredBuilt = Schema.Struct({
  op: Schema.Struct({
    sender: AddressValue,
    nonce: Quantity,
    callData: HexValue,
    callGasLimit: Quantity,
    verificationGasLimit: Quantity,
    preVerificationGas: Quantity,
    maxFeePerGas: Quantity,
    maxPriorityFeePerGas: Quantity,
    signature: HexValue,
    paymaster: Schema.optionalKey(AddressValue),
    paymasterVerificationGasLimit: Schema.optionalKey(Quantity),
    paymasterPostOpGasLimit: Schema.optionalKey(Quantity),
    paymasterData: Schema.optionalKey(HexValue),
    eip7702Auth: Schema.optionalKey(Authorization),
  }),
  entryPoint: AddressValue,
  chainId: Natural,
  maxCost: Schema.String.pipe(Schema.check(Schema.makeFilter((value) => /^\d+$/.test(value)))),
  userOpHash: HashValue,
})
const AaRecord = Schema.Struct({
  actionId: Schema.String.pipe(Schema.check(Schema.makeFilter((value) => value.length > 0))),
  /** The action's gas lane, chosen when it was first saved: MON-paid (no paymaster), or USDC when absent. */
  payment: Schema.optionalKey(Schema.Literals(['native'])),
  built: Schema.optionalKey(StoredBuilt),
  submittedAt: Schema.optionalKey(Natural),
  block: Schema.optionalKey(Quantity),
  spent: Schema.optionalKey(Schema.Boolean),
  outcome: Schema.optionalKey(Schema.Literals(['refused', 'dropped'])),
  receipt: Schema.optionalKey(Schema.Struct({ txHash: HashValue, status: Schema.Literals(['success', 'reverted']) })),
})
export type AaJournal = Schema.Schema.Type<typeof AaRecord>
export const decodeAaJournal = Schema.decodeUnknownSync(AaRecord)

export const storeBuilt = (built: sdk.BuiltUserOp): Schema.Schema.Type<typeof StoredBuilt> => ({
  op: sdk.toBundlerJson(built.op, built.authorization),
  entryPoint: built.entryPoint,
  chainId: built.chainId,
  maxCost: built.maxCost.toString(),
  userOpHash: built.userOpHash,
})

/** Decode the validated JSON form back into SDK amounts; the hash and lane must still match. */
export function restoreBuilt(record: AaJournal): sdk.BuiltUserOp {
  const stored = record.built
  if (stored === undefined) throw new Error('No saved user operation to reconcile.')
  const { op } = stored
  // SAFETY: decodeAaJournal validates every hex field, address, quantity and optional authorization before use.
  const encoded = op as ReturnType<typeof sdk.toBundlerJson>
  const { eip7702Auth: authorization, paymasterVerificationGasLimit, paymasterPostOpGasLimit, ...baseOp } = encoded
  const built: sdk.BuiltUserOp = {
    chainId: stored.chainId,
    // SAFETY: StoredBuilt validates both 20-byte addresses and the 32-byte hash.
    entryPoint: stored.entryPoint,
    // SAFETY: StoredBuilt validates the 32-byte hash.
    userOpHash: stored.userOpHash,
    maxCost: BigInt(stored.maxCost),
    op: {
      ...baseOp,
      nonce: BigInt(op.nonce),
      callGasLimit: BigInt(op.callGasLimit),
      verificationGasLimit: BigInt(op.verificationGasLimit),
      preVerificationGas: BigInt(op.preVerificationGas),
      maxFeePerGas: BigInt(op.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
      ...(op.paymasterVerificationGasLimit === undefined
        ? {}
        : { paymasterVerificationGasLimit: BigInt(op.paymasterVerificationGasLimit) }),
      ...(op.paymasterPostOpGasLimit === undefined
        ? {}
        : { paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit) }),
    },
    ...(authorization === undefined
      ? {}
      : {
          authorization: {
            ...authorization,
            chainId: Number(BigInt(authorization.chainId)),
            nonce: Number(BigInt(authorization.nonce)),
            yParity: Number(BigInt(authorization.yParity)),
          },
        }),
  }
  if (
    built.op.nonce !== sdk.laneNonce(sdk.nonceKey(record.actionId)) ||
    sdk.userOpHash(built.op, built.chainId, built.entryPoint).toLowerCase() !== built.userOpHash.toLowerCase()
  )
    throw new Error('Saved user operation differs from its action lane or hash. Reconcile before continuing.')
  return built
}
