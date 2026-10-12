import { readFileSync } from 'node:fs'
import { type Abi, type AbiFunction, erc20Abi, parseAbi, toHex, zeroAddress } from 'viem'
import { coreAbi, sidequestEvaluatorAbi, sidequestHoldingAbi, stakeVaultAbi } from '../../src/abi/index.ts'
import { DELEGATION_TYPES, delegationManagerAbi } from '../../src/delegation/index.ts'
import { directoryDomainFields, directoryDomainName, directoryRecordFields } from '../../src/directory.ts'
import { stageProfile } from '../../../../infra/stage.ts'
import { selectionTypes, setBudgetTypes, submitTypes } from '../../src/typed-data.ts'

export const config = JSON.parse(
  readFileSync(new URL('../../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'),
)
if (config.chainId !== 10143) throw new Error('P0 requires Monad testnet 10143')

export const domainTypes = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

export const agentWalletTypes = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
}

/** EIP-3009, as x402 `exact` payments sign it against the token's own domain (testnet USDC: "USDC", version "2"). */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/** The most one x402 payment may move, in USDC base units (6 decimals). The hosted ledger caps each day below it. */
export const X402_PAYMENT_CAP = '5000000'
export const RELAY_ADDRESSES = [stageProfile('dev')!.relay, stageProfile('prod')!.relay] as const

/** Directory records a hosted agent may sign (V1.1 WS8); Heartbeat stays refused by hosted signing. */
export const DIRECTORY_RECORD_KINDS = ['Enrollment', 'ServiceAd', 'RevokeAd'] as const

export interface SigningShape {
  name: string
  contract: string
  types: Record<string, readonly { name: string; type: string }[]>
  /** The EIP712Domain fields the signer sends, when not name/version/chainId/verifyingContract. */
  domain?: readonly { name: string; type: string }[]
  primaryType: string
  field: string
  operator: string
  value: string
  /** Further message conditions, all required. */
  also?: readonly { field: string; operator: string; value: string }[]
}

export const signingShapes: readonly SigningShape[] = [
  {
    name: 'SidequestHolding',
    contract: config.deployment.main.holding,
    types: selectionTypes,
    primaryType: 'Selection',
    field: 'nonce',
    operator: 'gte',
    value: '0',
  },
  {
    name: 'ERC8183',
    contract: config.deployment.core,
    types: setBudgetTypes,
    primaryType: 'SetBudgetAuthorization',
    field: 'signer',
    operator: 'eq',
    value: '{{wallet.address}}',
  },
  {
    name: 'ERC8183',
    contract: config.deployment.core,
    types: submitTypes,
    primaryType: 'SubmitAuthorization',
    field: 'signer',
    operator: 'eq',
    value: '{{wallet.address}}',
  },
  {
    name: 'DelegationManager',
    contract: config.delegation.manager,
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    field: 'delegate',
    operator: 'eq',
    value: config.roles.relay,
  },
  {
    name: 'ERC8004IdentityRegistry',
    contract: config.erc8004.identity,
    types: agentWalletTypes,
    primaryType: 'AgentWalletSet',
    field: 'newWallet',
    operator: 'eq',
    value: '{{wallet.address}}',
  },
  // x402 (ADR-0013 amendment): only from the agent's own wallet, only the configured USDC, at most one payment cap.
  {
    name: 'USDC',
    contract: config.x402.usdc,
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    field: 'from',
    operator: 'eq',
    value: '{{wallet.address}}',
    also: [{ field: 'value', operator: 'lte', value: X402_PAYMENT_CAP }],
  },
  // Directory records: the agent's own wallet on this identity registry, record version 1; the domain's name and its
  // salt (the audience) are application-enforced, as Privy conditions only chainId and verifyingContract.
  ...DIRECTORY_RECORD_KINDS.map((kind) => ({
    name: directoryDomainName(kind),
    contract: zeroAddress,
    types: { [kind]: directoryRecordFields },
    domain: directoryDomainFields,
    primaryType: kind,
    field: 'wallet',
    operator: 'eq',
    value: '{{wallet.address}}',
    also: [
      { field: 'identityRegistry', operator: 'eq', value: config.erc8004.identity },
      { field: 'version', operator: 'eq', value: '1' },
    ],
  })),
]

export function schema(shape: SigningShape): {
  types: Record<string, readonly { name: string; type: string }[]>
  primary_type: string
} {
  return { types: { EIP712Domain: shape.domain ?? domainTypes, ...shape.types }, primary_type: shape.primaryType }
}

/**
 * Every call a hosted agent's user operation may contain (ADR-0023), as one target and its methods: the protocol's
 * work methods (D15, the B1 grant's lists plus the worker's own `attachEvidence` and the operator-approved
 * `requestUndelegate`), redemptions of the allowances operators sign to the agent, and disabling them. Privy decodes the
 * DeleGator's `execute` batch and every inner call must match one of these rules.
 */
const agentSweepAbi = parseAbi(['function sweep(address token, uint256 agentId, uint256 amount)'])

export const userOpTargets: readonly { name: string; to: string; abi: Abi; methods: readonly string[] }[] = [
  {
    name: 'Holding',
    to: config.deployment.main.holding,
    abi: sidequestHoldingAbi,
    methods: ['activate', 'cancel', 'cancelSelection', 'claimTopUpRefund', 'settle', 'withdraw', 'publish'],
  },
  {
    name: 'Evaluator',
    to: config.deployment.main.evaluator,
    abi: sidequestEvaluatorAbi,
    methods: [
      'accept',
      'reject',
      'dispute',
      'completeAfterSilence',
      'rejectAfterDeliveryDeadline',
      'rejectAfterWindow',
      'refundAfterArbitrationTimeout',
      'retryDeferred',
      'attachEvidence',
    ],
  },
  {
    name: 'Vault',
    to: config.deployment.sidequest.vault,
    abi: stakeVaultAbi,
    methods: ['cancelUndelegate', 'withdraw', 'requestUndelegate'],
  },
  { name: 'Core', to: config.deployment.core, abi: coreAbi, methods: ['submit', 'submitClaim', 'claimRefund'] },
  {
    name: 'DelegationManager',
    to: config.delegation.manager,
    abi: delegationManagerAbi,
    methods: ['redeemDelegations', 'disableDelegation'],
  },
  // Earnings leave an agent only to its ERC-8004 owner; the contract checks the caller is the agent's wallet.
  ...(config.deployment.agentSweep === undefined
    ? []
    : [{ name: 'AgentSweep', to: config.deployment.agentSweep, abi: agentSweepAbi, methods: ['sweep'] }]),
]

const fragment = (abi: Abi, method: string): AbiFunction => {
  const found = abi.find((item): item is AbiFunction => item.type === 'function' && item.name === method)
  if (found === undefined) throw new Error(`User-op rule method ${method} is missing from its ABI`)
  return found
}

const onChain = {
  field_source: 'ethereum_transaction',
  field: 'chain_id',
  operator: 'eq',
  value: String(config.chainId),
}
const noValue = { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: '0x0' }
const calling = (abi: Abi, method: string, field: string, operator: string, value: string) => ({
  field_source: 'ethereum_calldata',
  abi: [fragment(abi, method)],
  field,
  operator,
  value,
})

/** Privy refuses a rule name of 50 characters or more. */
export const RULE_NAME_LIMIT = 50

/**
 * The `eth_signUserOperation` rules: each pins the chain, the target, no native value and the function. Approvals pin
 * their spender: any token to the Holding (a hire's reward and bond), and the gas token to the paymaster, at most its
 * standing approval. Privy cannot see the paymaster or the gas fields of the operation; the application checks those.
 */
export function userOpRules() {
  const calls = userOpTargets.flatMap((target) =>
    target.methods.map((method) => ({
      name: `userOp ${target.name}.${method}`,
      method: 'eth_signUserOperation',
      action: 'ALLOW',
      conditions: [
        onChain,
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: target.to },
        noValue,
        calling(target.abi, method, 'function_name', 'eq', method),
      ],
    })),
  )
  const aa = config.accountAbstraction
  const paymaster =
    aa?.paymaster === undefined
      ? []
      : [
          {
            name: 'userOp gas token approve to the paymaster',
            method: 'eth_signUserOperation',
            action: 'ALLOW',
            conditions: [
              onChain,
              { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: aa.gasToken },
              noValue,
              calling(erc20Abi, 'approve', 'approve.spender', 'eq', aa.paymaster),
              calling(erc20Abi, 'approve', 'approve.amount', 'lte', toHex(BigInt(aa.standingApproval))),
            ],
          },
        ]
  return [
    ...calls,
    {
      name: 'userOp approve to the Holding',
      method: 'eth_signUserOperation',
      action: 'ALLOW',
      conditions: [
        onChain,
        noValue,
        calling(erc20Abi, 'approve', 'approve.spender', 'eq', config.deployment.main.holding),
      ],
    },
    ...paymaster,
    ...(config.deployment.agentSweep === undefined
      ? []
      : [
          {
            name: 'userOp approve to AgentSweep',
            method: 'eth_signUserOperation',
            action: 'ALLOW',
            conditions: [
              onChain,
              noValue,
              calling(erc20Abi, 'approve', 'approve.spender', 'eq', config.deployment.agentSweep),
            ],
          },
        ]),
  ]
}

export function authorityPolicy(ownerId: string) {
  const rules = signingShapes.map((shape) => ({
    name: `Allow ${shape.primaryType}`,
    method: 'eth_signTypedData_v4',
    action: 'ALLOW',
    conditions: [
      { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '10143' },
      { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: shape.contract },
      {
        field_source: 'ethereum_typed_data_message',
        typed_data: schema(shape),
        field: shape.field,
        operator: shape.primaryType === 'Delegation' && shape.field === 'delegate' ? 'in' : shape.operator,
        value: shape.primaryType === 'Delegation' && shape.field === 'delegate' ? [...RELAY_ADDRESSES] : shape.value,
      },
      ...(shape.also ?? []).map((condition) => ({
        field_source: 'ethereum_typed_data_message',
        typed_data: schema(shape),
        ...condition,
      })),
    ],
  }))
  return {
    version: '1.0',
    name: 'Sidequest v2 Monad testnet routine signer',
    chain_type: 'ethereum',
    owner_id: ownerId,
    rules: [
      ...rules,
      ...userOpRules(),
      {
        name: 'Allow DeleGator upgrade',
        method: 'eth_sign7702Authorization',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'ethereum_7702_authorization',
            field: 'contract',
            operator: 'eq',
            value: config.delegation.delegator,
          },
        ],
      },
      { name: 'Deny export', method: 'exportPrivateKey', action: 'DENY', conditions: [] },
    ],
  }
}

/** Unsupported policy fields stay explicit until the application validator and live fixtures prove them. */
export const appEnforced = [
  'EIP-712 domain name and version',
  'x402 payee, validity window (≤ 600 s), nonce uniqueness and the 24 h hosted ledger',
  'Directory record domain salt = keccak256(audience), agentId = the bound agent, audience = the request origin, ' +
    'expiresAt − issuedAt ≤ 300 s (86 400 s for ServiceAd); Heartbeat refused',
  'Selection spending limit and linkage to the frozen job',
  'SetBudgetAuthorization freshly quoted net and activated job',
  'Delegation B1/B2/B3 caveat templates, including pinned arguments',
  '7702 chain_id = 10143 (Privy documents only the contract condition)',
]
