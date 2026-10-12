import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { type Address, type Hex, decodeFunctionData, isAddress, isHex } from 'viem'

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
const Request = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('agent') }),
  Schema.Struct({ kind: Schema.Literal('permission'), permissionId: HashText }),
  Schema.Struct({
    kind: Schema.Literal('reward'),
    token: AddressText,
    amount: Schema.String.pipe(Schema.check(Schema.makeFilter((value) => /^[1-9]\d*$/.test(value)))),
    displayAmount: Schema.String,
  }),
])
const Journal = Schema.Struct({
  key: Schema.String.pipe(Schema.check(Schema.makeFilter((value) => value.length > 0))),
  request: Request,
  phase: Schema.Literals(['prepare', 'send', 'readback']),
  transactions: Schema.Array(Step),
})
export type OperatorRequest = Schema.Schema.Type<typeof Request>
export type DisableJournal = Schema.Schema.Type<typeof Journal>
const readJournal = Schema.decodeUnknownSync(Journal)
const readTransactions = Schema.decodeUnknownSync(Schema.Struct({ transactions: Schema.Array(Step) }))

/** A returned disable is authority only for this operator, agent, chain, manager and selected hash. */
export function reviewOperatorDisables(input: {
  deployment: sdk.Deployment
  operator: Address
  agent: Address
  response: unknown
  hashes?: readonly Hex[]
}): Array<Schema.Schema.Type<typeof Step>> {
  const { transactions } = readTransactions(input.response)
  const seen = new Set<string>()
  for (const tx of transactions) {
    if (
      tx.chainId !== input.deployment.chainId ||
      tx.to.toLowerCase() !== input.deployment.delegation.manager.toLowerCase()
    )
      throw new Error('The permission disable uses another network or target.')
    const decoded = decodeFunctionData({ abi: sdk.delegationManagerAbi, data: tx.data })
    if (decoded.functionName !== 'disableDelegation') throw new Error('Expected a permission disable only.')
    const grant = decoded.args[0]
    const hash = sdk.delegationHash(grant).toLowerCase()
    if (
      grant.delegator.toLowerCase() !== input.operator.toLowerCase() ||
      grant.delegate.toLowerCase() !== input.agent.toLowerCase() ||
      (input.hashes !== undefined && !input.hashes.some((expected) => expected.toLowerCase() === hash)) ||
      seen.has(hash)
    )
      throw new Error('The disable differs from this operator, agent or selected permission.')
    seen.add(hash)
  }
  return [...transactions]
}

export function readDisableJournal(storage: Pick<Storage, 'getItem'>, key: string): DisableJournal | null {
  const saved = storage.getItem(key)
  return saved === null ? null : readJournal(JSON.parse(saved))
}
export function writeDisableJournal(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string,
  journal: DisableJournal | null,
): void {
  if (journal === null) {
    storage.removeItem(key)
    if (storage.getItem(key) !== null) throw new Error('The permission action journal could not be cleared.')
    return
  }
  const saved = JSON.stringify(readJournal(journal))
  storage.setItem(key, saved)
  if (storage.getItem(key) !== saved)
    throw new Error('The permission action journal is unavailable. Nothing may start.')
}

export function operatorRequest(request: OperatorRequest, key: string) {
  if (request.kind === 'agent') return { action: 'revoke', body: {} }
  if (request.kind === 'reward')
    return { action: 'allowance-prepare', body: { key, token: request.token, amount: request.amount } }
  return {
    action: 'execute',
    body: { tool: 'revoke_permission', args: { permissionId: request.permissionId }, operationKey: key },
  }
}

/** After a mined send the journal permits readback only, even after a reload or a lost API response. */
export function afterOperatorSend(journal: DisableJournal): DisableJournal {
  if (journal.phase !== 'send') throw new Error('There is no reviewed disable send to confirm.')
  return { ...journal, phase: 'readback' }
}

const PermissionRows = Schema.Struct({
  permissions: Schema.Array(Schema.Struct({ permissionId: HashText, status: Schema.String, expiresAt: Schema.Number })),
})
export function requirePermissionReadback(response: unknown, permissionId: Hex, now = Date.now() / 1000): void {
  const row = Schema.decodeUnknownSync(PermissionRows)(response).permissions.find(
    (item) => item.permissionId.toLowerCase() === permissionId.toLowerCase(),
  )
  if (row === undefined || (row.status !== 'disabled' && row.expiresAt > now))
    throw new Error('On-chain disablement is unconfirmed. Retry its readback before continuing.')
}
