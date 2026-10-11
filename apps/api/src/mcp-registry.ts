import { directoryTools } from './directory.ts'
import { feedTools } from './feed.ts'
import { networkTool } from './mcp-policy.ts'
import { agentTools } from './tools-agents.ts'
import { tenantTools } from './tools-tenant.ts'
import { tools } from './tools.ts'

/**
 * Every tool hosted MCP serves on this network. What one connection lists or may call is decided per request by
 * mcp-policy (listedTool, toolRefusal), never by trimming this registry first: a setup chat must list its agent's tools
 * before approval, because clients cache the list.
 */
export function hostedMcpTools(network: string) {
  return Object.fromEntries(
    Object.entries({ ...tools, ...tenantTools, ...directoryTools, ...agentTools, ...feedTools }).filter(([name]) =>
      networkTool(network, name),
    ),
  )
}
