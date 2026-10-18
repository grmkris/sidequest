/** HTTP parsing only. The management object authenticates and owns every lifecycle write. */
export interface AgentRouteRequest {
  readonly action: string
  readonly id?: string
  readonly body: Record<string, unknown>
  readonly avatarBytes?: Uint8Array
}

/** Actions two levels below an agent: generating its avatar, and ending one of its connections. */
function nestedAgentRoute(method: string, path: string, body: Record<string, unknown>): AgentRouteRequest | undefined {
  if (method !== 'POST') return undefined
  const disconnect = /^\/api\/agents\/([A-Za-z0-9_-]{1,128})\/connections\/(oauth_[0-9a-f]{40})\/disconnect$/.exec(path)
  if (disconnect !== null) return { action: 'disconnect', id: disconnect[1]!, body: { familyId: disconnect[2]! } }
  const generate = /^\/api\/agents\/([A-Za-z0-9_-]{1,128})\/avatar\/generate$/.exec(path)
  if (generate !== null) return { action: 'avatar-generate', id: generate[1]!, body }
  return undefined
}

export function agentRoute(method: string, path: string, body: Record<string, unknown>): AgentRouteRequest | undefined {
  if (path === '/api/agents' && method === 'GET') return { action: 'list', body }
  if (path === '/api/agents' && method === 'POST') return { action: 'create', body }
  if (path === '/api/agents/setup-identity' && method === 'POST') return { action: 'setup-identity', body }
  const nested = nestedAgentRoute(method, path, body)
  if (nested !== undefined) return nested
  const match = /^\/api\/agents\/([A-Za-z0-9_-]{1,128})(?:\/([a-z-]+))?$/.exec(path)
  if (match === null) return undefined
  const id = match[1]!
  const action = match[2] ?? 'status'
  if (method === 'GET' && ['status', 'recovery', 'connections', 'balances'].includes(action))
    return { action, id, body }
  if (
    method === 'POST' &&
    [
      'resume',
      'registration-prepare',
      'registration-confirm',
      'registration-batch',
      'registration-record',
      'allowance-prepare',
      'allowance-confirm',
      'gas-allowance-prepare',
      'gas-allowance-confirm',
      'gas-allowance-edit',
      'gas-allowance-revoke',
      'stop-access',
      'revoke',
      'signer-removed',
      'execute',
      'profile',
      'avatar',
      'approve',
      'roles',
    ].includes(action)
  )
    return { action, id, body }
  return undefined
}
