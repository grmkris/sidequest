import { expect, it } from 'vitest'
import { PERMISSION_TOOLS, networkTool, permittedTool, requiredToolScope } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'

it('permission tools read with the read scope, write with work only, and stay off mainnet until promotion', () => {
  expect([...PERMISSION_TOOLS].every((name) => Object.hasOwn(agentTools, name))).toBe(true)
  expect(requiredToolScope('get_permissions')).toBe('sidequest:read')
  expect(requiredToolScope('get_supported_permissions')).toBe('sidequest:read')
  for (const name of ['request_permissions', 'use_permission', 'revoke_permission']) {
    expect(requiredToolScope(name)).toBe('sidequest:work')
    expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:work'] }, name)).toBe(true)
    expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:hire'] }, name)).toBe(false)
    expect(permittedTool({ scopes: ['sidequest:read'] }, name)).toBe(false)
  }
  for (const name of PERMISSION_TOOLS) {
    expect(networkTool('monad-testnet', name)).toBe(true)
    expect(networkTool('monad-mainnet', name)).toBe(false)
  }
  expect(networkTool('monad-mainnet', 'create_task')).toBe(true)
})
