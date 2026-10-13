import { readFileSync } from 'node:fs'
import { type Abi, type AbiFunction, erc20Abi, isAddress, parseAbi, toHex, zeroAddress } from 'viem'
import { coreAbi, sidequestEvaluatorAbi, sidequestHoldingAbi, stakeVaultAbi } from '../../src/abi/index.ts'
import { DELEGATION_TYPES, delegationManagerAbi } from '../../src/delegation/index.ts'
import { directoryDomainFields, directoryDomainName, directoryRecordFields } from '../../src/directory.ts'
import { stageProfile } from '../../../../infra/stage.ts'
import { selectionTypes, setBudgetTypes, submitTypes } from '../../src/typed-data.ts'
import { deployment, type Deployment, type Network } from '../../src/deployment.ts'

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

interface PolicyConfig {
  chainId: number
  roles: { relay: string }
  erc8004: { identity: string }
  delegation: { manager: string; delegator: string }
  x402: { usdc: string }
  accountAbstraction?: {
    paymaster?: string
    gasToken: string
    standingApproval: string
  }
  deployment: {
    core: string
    main: { holding: string; evaluator: string }
    sidequest: { vault: string }
    agentSweep?: string
  }
}

/** The checked-in testnet policy remains the compatibility fixture and default. */
export const config = JSON.parse(
  readFileSync(new URL('../../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'),
)
if (config.chainId !== 10143) throw new Error('P0 requires Monad testnet 10143')

function policyConfig(selected: Deployment): PolicyConfig {
  const main = selected.stacks.main
  const sidequest = selected.sidequest
  const aa = selected.aa
  if (main === undefined || sidequest === null || aa === null)
    throw new Error('Privy policy requires promoted Holding, Vault and account abstraction configuration')
  if (selected.network === 'monad-mainnet' && (selected.agentSweep === null || aa.paymaster === null))
    throw new Error('Mainnet Privy policy requires promoted AgentSweep and paymaster addresses')
  const targets = [
    selected.core,
    main.holding,
    main.evaluator,
    sidequest.vault,
    selected.delegation.manager,
    selected.delegation.delegator,
    selected.identity,
    aa.entryPoint,
    aa.gasToken,
  ]
  if (selected.agentSweep !== null) targets.push(selected.agentSweep)
  if (aa.paymaster !== null) targets.push(aa.paymaster)
  if (targets.some((target) => !isAddress(target, { strict: false }) || target.toLowerCase() === zeroAddress))
    throw new Error('Privy policy requires nonzero promoted target addresses')
  if (selected.chainId !== (selected.network === 'monad-mainnet' ? 143 : 10143))
    throw new Error('Privy policy deployment network/chain mismatch')
  return {
    chainId: selected.chainId,
    roles: { relay: selected.relay },
    erc8004: { identity: selected.identity },
    delegation: { manager: selected.delegation.manager, delegator: selected.delegation.delegator },
    x402: { usdc: selected.x402?.usdc ?? aa.gasToken },
    accountAbstraction: {
      ...(aa.paymaster === null ? {} : { paymaster: aa.paymaster }),
      gasToken: aa.gasToken,
      standingApproval: aa.standingApproval.toString(),
    },
    deployment: {
      core: selected.core,
      main: { holding: main.holding, evaluator: main.evaluator },
      sidequest: { vault: sidequest.vault },
      ...(selected.agentSweep === null ? {} : { agentSweep: selected.agentSweep }),
    },
  }
}

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

/** The most one x402 payment may move, in USDC base units (testnet and mainnet use the same cap). */
export const X402_PAYMENT_CAP = '5000000'
export const RELAY_ADDRESSES = [stageProfile('dev'), stageProfile('prod')]
  .filter((profile) => profile?.network === 'monad-testnet')
  .map((profile) => profile?.relay)
  .filter((relay): relay is `0x${string}` => relay !== undefined)
export const DIRECTORY_RECORD_KINDS = ['Enrollment', 'ServiceAd', 'RevokeAd'] as const

function signingShapesFor(selected: PolicyConfig): readonly SigningShape[] {
  return [
    {
      name: 'SidequestHolding',
      contract: selected.deployment.main.holding,
      types: selectionTypes,
      primaryType: 'Selection',
      field: 'nonce',
      operator: 'gte',
      value: '0',
    },
    {
      name: 'ERC8183',
      contract: selected.deployment.core,
      types: setBudgetTypes,
      primaryType: 'SetBudgetAuthorization',
      field: 'signer',
      operator: 'eq',
      value: '{{wallet.address}}',
    },
    {
      name: 'ERC8183',
      contract: selected.deployment.core,
      types: submitTypes,
      primaryType: 'SubmitAuthorization',
      field: 'signer',
      operator: 'eq',
      value: '{{wallet.address}}',
    },
    {
      name: 'DelegationManager',
      contract: selected.delegation.manager,
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      field: 'delegate',
      operator: 'eq',
      value: selected.roles.relay,
    },
  ]
}

function identityShapes(selected: PolicyConfig): readonly SigningShape[] {
  return [
    {
      name: 'ERC8004IdentityRegistry',
      contract: selected.erc8004.identity,
      types: agentWalletTypes,
      primaryType: 'AgentWalletSet',
      field: 'newWallet',
      operator: 'eq',
      value: '{{wallet.address}}',
    },
    {
      name: 'USDC',
      contract: selected.x402.usdc,
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      field: 'from',
      operator: 'eq',
      value: '{{wallet.address}}',
      also: [{ field: 'value', operator: 'lte', value: X402_PAYMENT_CAP }],
    },
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
        { field: 'identityRegistry', operator: 'eq', value: selected.erc8004.identity },
        { field: 'version', operator: 'eq', value: '1' },
      ],
    })),
  ]
}

export const signingShapes = [...signingShapesFor(config), ...identityShapes(config)]

export function schema(shape: SigningShape): {
  types: Record<string, readonly { name: string; type: string }[]>
  primary_type: string
} {
  return { types: { EIP712Domain: shape.domain ?? domainTypes, ...shape.types }, primary_type: shape.primaryType }
}

const agentSweepAbi = parseAbi(['function sweep(address token, uint256 agentId, uint256 amount)'])
type UserOpTarget = { name: string; to: string; abi: Abi; methods: readonly string[] }

function userOpTargetsFor(selected: PolicyConfig): readonly UserOpTarget[] {
  return [
    {
      name: 'Holding',
      to: selected.deployment.main.holding,
      abi: sidequestHoldingAbi,
      methods: ['activate', 'cancel', 'cancelSelection', 'claimTopUpRefund', 'settle', 'withdraw', 'publish'],
    },
    {
      name: 'Evaluator',
      to: selected.deployment.main.evaluator,
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
      to: selected.deployment.sidequest.vault,
      abi: stakeVaultAbi,
      methods: ['cancelUndelegate', 'withdraw', 'requestUndelegate'],
    },
    { name: 'Core', to: selected.deployment.core, abi: coreAbi, methods: ['submit', 'submitClaim', 'claimRefund'] },
    {
      name: 'DelegationManager',
      to: selected.delegation.manager,
      abi: delegationManagerAbi,
      methods: ['redeemDelegations', 'disableDelegation'],
    },
    ...(selected.deployment.agentSweep === undefined
      ? []
      : [{ name: 'AgentSweep', to: selected.deployment.agentSweep, abi: agentSweepAbi, methods: ['sweep'] }]),
  ]
}

export const userOpTargets = userOpTargetsFor(config)

const fragment = (abi: Abi, method: string): AbiFunction => {
  const found = abi.find((item): item is AbiFunction => item.type === 'function' && item.name === method)
  if (found === undefined) throw new Error(`User-op rule method ${method} is missing from its ABI`)
  return found
}
const noValue = { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: '0x0' }
const calling = (abi: Abi, method: string, field: string, operator: string, value: string) => ({
  field_source: 'ethereum_calldata',
  abi: [fragment(abi, method)],
  field,
  operator,
  value,
})
export const RULE_NAME_LIMIT = 50

function userOpRulesFor(selected: PolicyConfig) {
  const onChain = {
    field_source: 'ethereum_transaction',
    field: 'chain_id',
    operator: 'eq',
    value: String(selected.chainId),
  }
  const targets = userOpTargetsFor(selected)
  const calls = targets.flatMap((target) =>
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
  const aa = selected.accountAbstraction
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
        calling(erc20Abi, 'approve', 'approve.spender', 'eq', selected.deployment.main.holding),
      ],
    },
    ...paymaster,
    ...(selected.deployment.agentSweep === undefined
      ? []
      : [
          {
            name: 'userOp approve to AgentSweep',
            method: 'eth_signUserOperation',
            action: 'ALLOW',
            conditions: [
              onChain,
              noValue,
              calling(erc20Abi, 'approve', 'approve.spender', 'eq', selected.deployment.agentSweep),
            ],
          },
        ]),
  ]
}

export function userOpRules() {
  return userOpRulesFor(config)
}

export function authorityPolicy(ownerId: string, network: Network) {
  let selected: Deployment
  try {
    selected = deployment(network)
  } catch {
    throw new Error(`Privy policy requires a promoted deployment in contracts/config/${network}.json`)
  }
  return policyFromDeployment(ownerId, selected)
}

/** Offline fixtures use the same checked SDK deployment as the network generator. */
export function policyFromDeployment(ownerId: string, selectedDeployment: Deployment) {
  const selected = policyConfig(selectedDeployment)
  const network = selectedDeployment.network
  const shapes = [...signingShapesFor(selected), ...identityShapes(selected)].filter(
    (shape) => network === 'monad-testnet' || shape.primaryType !== 'Delegation',
  )
  const relayCondition = { operator: 'in', value: [...RELAY_ADDRESSES] }
  const rules = shapes.map((shape) => ({
    name: `Allow ${shape.primaryType}`,
    method: 'eth_signTypedData_v4',
    action: 'ALLOW',
    conditions: [
      { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: String(selected.chainId) },
      { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: shape.contract },
      {
        field_source: 'ethereum_typed_data_message',
        typed_data: schema(shape),
        field: shape.field,
        operator:
          shape.primaryType === 'Delegation' && shape.field === 'delegate' ? relayCondition.operator : shape.operator,
        value: shape.primaryType === 'Delegation' && shape.field === 'delegate' ? relayCondition.value : shape.value,
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
    name: `Sidequest v2 ${network === 'monad-mainnet' ? 'Monad mainnet' : 'Monad testnet'} routine signer`,
    chain_type: 'ethereum',
    owner_id: ownerId,
    rules: [
      ...rules,
      ...userOpRulesFor(selected),
      {
        name: 'Allow DeleGator upgrade',
        method: 'eth_sign7702Authorization',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'ethereum_7702_authorization',
            field: 'contract',
            operator: 'eq',
            value: selected.delegation.delegator,
          },
        ],
      },
      { name: 'Deny export', method: 'exportPrivateKey', action: 'DENY', conditions: [] },
    ],
  }
}

export const appEnforced = [
  'EIP-712 domain name and version',
  'x402 payee, validity window (≤ 600 s), nonce uniqueness and the 24 h hosted ledger',
  'Directory record domain salt = keccak256(audience), agentId = the bound agent, audience = the request origin, ' +
    'expiresAt − issuedAt ≤ 300 s (86 400 s for ServiceAd); Heartbeat refused',
  'Selection spending limit and linkage to the frozen job',
  'SetBudgetAuthorization freshly quoted net and activated job',
  'Delegation B1/B2/B3 caveat templates, including pinned arguments',
  '7702 chain_id is selected from the network config (Privy documents only the contract condition)',
]
