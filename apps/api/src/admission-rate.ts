import { isIP } from 'node:net'
import {
  ADMISSION_OBJECT_NAME,
  SPONSOR_OBJECT_NAME,
  admissionFailure,
  parseHostedAdmission,
  readOnlyHostedTools,
  SessionDesk,
} from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import type { Network } from '@sidequest/sdk'
import type { OAuthGrant } from './oauth.ts'
import { resourceBoard } from './oauth-validation.ts'
import { OPERATOR_CONTINUATIONS, toolDecision } from './mcp-policy.ts'

export interface AdmissionCall {
  network: Network
  tool: string
  boardId: string
  bearer?: string | undefined
  mcpSession?: string | undefined
  caller?: string | undefined
  /** Only the host Worker supplies this, from CF-Connecting-IP; never from tool arguments. */
  ip?: string | undefined
  agentAuth?: { agentId: string; resource: string; operator?: boolean }
}

export type AdmissionReply = { ok: true } | { ok: false; code: string; message: string; retryAfter?: number }
export interface AdmissionNamespace {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): { admit(input: AdmissionCall): Promise<string> }
}

export const needsWriteRate = (tool: string) =>
  !readOnlyHostedTools.has(tool) || tool === 'auth_challenge' || tool === 'auth_login'

export async function admissionIdentity(bindings: Record<string, unknown>, input: AdmissionCall) {
  if (bindings.NETWORK !== input.network || (input.network !== 'monad-mainnet' && bindings.DEPLOY_STAGE !== 'prod'))
    throw new Error('admission runtime network/stage mismatch')
  const desk = new SessionDesk({ sql: fromD1(bindings.Database as never), verify: async () => false })
  const session = await desk.resolve(input)
  let address = session?.address
  if (input.agentAuth !== undefined) {
    const namespace = bindings.Board as {
      idFromName(name: string): unknown
      get(id: unknown): { oauthResolve(req: { resource: string; bearer?: string }): Promise<string> }
    }
    if (input.agentAuth.operator === true) {
      const management = namespace.get(namespace.idFromName(SPONSOR_OBJECT_NAME)) as unknown as {
        operatorAgent(req: { agentId: string; bearer?: string }): Promise<string>
      }
      const agent = JSON.parse(
        await management.operatorAgent({
          agentId: input.agentAuth.agentId,
          ...(input.bearer === undefined ? {} : { bearer: input.bearer }),
        }),
      ) as { address: typeof address }
      if (!OPERATOR_CONTINUATIONS.has(input.tool)) throw new Error('Operator continuation scope mismatch')
      address = agent.address
    } else {
      const grant = JSON.parse(
        await namespace.get(namespace.idFromName(SPONSOR_OBJECT_NAME)).oauthResolve({
          resource: input.agentAuth.resource,
          ...(input.bearer === undefined ? {} : { bearer: input.bearer }),
        }),
      ) as OAuthGrant | null
      if (
        grant === null ||
        !grant.agentIds.includes(input.agentAuth.agentId) ||
        resourceBoard(grant.resource, new URL(grant.resource).origin) !== input.boardId ||
        toolDecision(grant, input.tool, true) !== 'allow'
      )
        throw new Error('OAuth admission scope mismatch')
      address = grant.address as typeof address
    }
  }
  if (input.caller !== undefined && input.caller.toLowerCase() !== address?.toLowerCase())
    throw new Error('caller is not the authenticated wallet')
  const policy = parseHostedAdmission(
    typeof bindings.PROD_ADMISSION_DRAIN === 'string' ? bindings.PROD_ADMISSION_DRAIN : '1',
  )
  const denied = admissionFailure(
    policy,
    input.network,
    input.boardId,
    input.tool,
    address,
    String(bindings.DEPLOY_STAGE ?? ''),
  )
  if (denied !== undefined) throw new Error(denied)
  return address
}

/** Canonicalize before hashing, so alternate IPv6 spellings share a counter. Never store the raw IP. */
export async function admissionIpHash(ip: string | undefined): Promise<string> {
  if (ip === undefined || isIP(ip) === 0) throw new Error('hosted writes require the edge client IP')
  const canonical = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.toLowerCase()))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Both the Worker and board DO use the same counter object; failures refuse the write. */
export async function enforceHostedRate(
  bindings: Record<string, unknown>,
  input: AdmissionCall,
): Promise<AdmissionReply> {
  if ((input.network !== 'monad-mainnet' && bindings.DEPLOY_STAGE !== 'prod') || !needsWriteRate(input.tool))
    return { ok: true }
  try {
    const namespace = bindings.Board as AdmissionNamespace | undefined
    if (namespace === undefined) throw new Error('missing admission namespace')
    return JSON.parse(await namespace.get(namespace.idFromName(ADMISSION_OBJECT_NAME)).admit(input)) as AdmissionReply
  } catch {
    return { ok: false, code: 'unavailable', message: 'hosted write admission unavailable' }
  }
}
