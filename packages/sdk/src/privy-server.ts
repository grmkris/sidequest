/** User-owned agent wallets. This client has no policy administration or transaction-send method. */
import { type Address, type Hex, type SignedAuthorization, isAddress, isHex, size, toHex } from 'viem'
import { type UserOperation, toPrivyJson } from './aa/userop.ts'
import { formatPrivyAuthorizationPayload } from './privy.ts'

export interface PrivyServerConfig {
  readonly appId: string
  readonly appSecret: string
  readonly sign: (payload: string) => Promise<string>
}

export interface PrivyAgentWallet {
  readonly id: string
  readonly address: Address
  readonly ownerId: string
  readonly signers: readonly { signerId: string; policyIds: readonly string[] }[]
}

/** Provider messages can echo request bodies. Only expose fixed status and bounded machine codes. */
export class PrivyServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Privy request refused: HTTP ${status} (${code})`)
  }
}

/** A 65-byte signature from a provider reply's `data.signature`. */
function signatureOf(result: Record<string, unknown>): Hex {
  const signature = String(new Map(Object.entries(Object(result.data))).get('signature'))
  if (!isHex(signature) || size(signature) !== 65) throw new PrivyServerError(200, 'invalid_signature_response')
  return signature
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(value)) throw new Error('Invalid Privy identifier')
  return encodeURIComponent(value)
}

export class PrivyServer {
  constructor(private readonly config: PrivyServerConfig) {}

  async #request(
    method: 'GET' | 'POST',
    route: string,
    body: Record<string, unknown>,
    key?: string,
    signed = false,
  ): Promise<Record<string, unknown>> {
    if (this.config.appId === '' || this.config.appSecret === '' || this.config.appSecret === 'unset')
      throw new PrivyServerError(0, 'unavailable')
    const url = `https://api.privy.io/v1${route}`
    const cleanBody = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
    const privyHeaders: Record<string, string> = { 'privy-app-id': this.config.appId }
    if (method === 'POST') {
      if (!key || key.length > 200) throw new Error('A persisted Privy operation key is required')
      privyHeaders['privy-idempotency-key'] = key
      privyHeaders['privy-request-expiry'] = String(Date.now() + 60_000)
    }
    const headers: Record<string, string> = {
      ...privyHeaders,
      authorization: `Basic ${btoa(`${this.config.appId}:${this.config.appSecret}`)}`,
      'content-type': 'application/json',
    }
    if (signed)
      headers['privy-authorization-signature'] = await this.config.sign(
        formatPrivyAuthorizationPayload({ method, url, body: cleanBody, headers: privyHeaders }),
      )
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(cleanBody) } : {}),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new PrivyServerError(0, 'unavailable')
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const candidate = json.code ?? json.error
      const code = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(candidate) ? candidate : 'unspecified'
      throw new PrivyServerError(response.status, code)
    }
    return json
  }

  #wallet(value: Record<string, unknown>): PrivyAgentWallet {
    const signers = value.additional_signers as Array<{ signer_id: string; override_policy_ids: string[] }> | undefined
    if (
      value.chain_type !== 'ethereum' ||
      typeof value.id !== 'string' ||
      typeof value.owner_id !== 'string' ||
      typeof value.address !== 'string' ||
      !isAddress(value.address) ||
      !Array.isArray(signers)
    )
      throw new PrivyServerError(200, 'invalid_wallet_response')
    return {
      id: value.id,
      address: value.address,
      ownerId: value.owner_id,
      signers: signers.map((signer) => ({ signerId: signer.signer_id, policyIds: signer.override_policy_ids })),
    }
  }

  async getWallet(walletId: string): Promise<PrivyAgentWallet> {
    return this.#wallet(await this.#request('GET', `/wallets/${identifier(walletId)}`, {}))
  }

  async verifyAgentWallet(
    walletId: string,
    userId: string,
    signerId: string,
    policyId: string,
  ): Promise<PrivyAgentWallet> {
    const wallet = await this.getWallet(walletId)
    const owner = await this.#request('GET', `/key_quorums/${identifier(wallet.ownerId)}`, {})
    const users = owner.user_ids
    const signer = wallet.signers[0]
    if (
      !Array.isArray(users) ||
      users.length !== 1 ||
      users[0] !== userId ||
      wallet.signers.length !== 1 ||
      signer?.signerId !== signerId ||
      signer.policyIds.length !== 1 ||
      signer.policyIds[0] !== policyId
    ) {
      throw new PrivyServerError(200, 'wallet_authority_mismatch')
    }
    return wallet
  }

  async createAgentWallet(input: {
    userId: string
    signerId: string
    policyId: string
    operationKey: string
  }): Promise<PrivyAgentWallet> {
    identifier(input.userId)
    identifier(input.signerId)
    identifier(input.policyId)
    const wallet = this.#wallet(
      await this.#request(
        'POST',
        '/wallets',
        {
          chain_type: 'ethereum',
          owner: { user_id: input.userId },
          additional_signers: [{ signer_id: input.signerId, override_policy_ids: [input.policyId] }],
        },
        input.operationKey,
      ),
    )
    return this.verifyAgentWallet(wallet.id, input.userId, input.signerId, input.policyId)
  }

  async signTypedData(walletId: string, typedData: string, operationKey: string): Promise<Hex> {
    const typed = JSON.parse(typedData) as { types: unknown; primaryType: string; domain: unknown; message: unknown }
    const result = await this.#request(
      'POST',
      `/wallets/${identifier(walletId)}/rpc`,
      {
        method: 'eth_signTypedData_v4',
        params: {
          typed_data: {
            types: typed.types,
            primary_type: typed.primaryType,
            domain: typed.domain,
            message: typed.message,
          },
        },
      },
      operationKey,
      true,
    )
    return signatureOf(result)
  }

  /**
   * The account's signature over one ERC-4337 user operation. `contract` is the implementation the account delegates
   * to, and Privy signs that contract's own digest of the operation (for the DeleGator, its EIP-712 PackedUserOperation).
   */
  async signUserOperation(
    walletId: string,
    contract: Address,
    chainId: number,
    op: UserOperation,
    operationKey: string,
  ): Promise<Hex> {
    if (!isAddress(contract) || !Number.isSafeInteger(chainId) || chainId <= 0)
      throw new Error('Invalid user operation')
    const result = await this.#request(
      'POST',
      `/wallets/${identifier(walletId)}/rpc`,
      {
        method: 'eth_signUserOperation',
        params: { contract, chain_id: toHex(chainId), user_operation: toPrivyJson(op) },
      },
      operationKey,
      true,
    )
    return signatureOf(result)
  }

  async signAuthorization(
    walletId: string,
    contract: Address,
    chainId: number,
    nonce: number,
    operationKey: string,
  ): Promise<SignedAuthorization<number>> {
    if (
      !isAddress(contract) ||
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !Number.isSafeInteger(nonce) ||
      nonce < 0
    )
      throw new Error('Invalid 7702 authorization')
    const result = await this.#request(
      'POST',
      `/wallets/${identifier(walletId)}/rpc`,
      {
        method: 'eth_sign7702Authorization',
        params: { contract, chain_id: chainId, nonce },
      },
      operationKey,
      true,
    )
    const a = (result.data as { authorization?: Record<string, unknown> } | undefined)?.authorization
    if (
      !a ||
      String(a.contract ?? a.address).toLowerCase() !== contract.toLowerCase() ||
      Number(a.chain_id) !== chainId ||
      Number(a.nonce) !== nonce ||
      typeof a.r !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(a.r) ||
      typeof a.s !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(a.s) ||
      ![0, 1].includes(Number(a.y_parity))
    )
      throw new PrivyServerError(200, 'invalid_authorization_response')
    return { address: contract, chainId, nonce, r: a.r as Hex, s: a.s as Hex, yParity: Number(a.y_parity) }
  }
}
