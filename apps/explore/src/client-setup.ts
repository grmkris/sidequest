export type Client = 'claude' | 'codex' | 'cursor' | 'grok'

export interface ClientSetup {
  /** What to run (for Cursor, what to save), once. */
  readonly line: string
  /** The sign-in when the browser runs elsewhere or its last page does not load. */
  readonly fallback?: string
  /** What follows the line. */
  readonly after: string
}

/**
 * How each coding client connects to Sidequest. `skill/start.md` and the docs quickstart repeat these lines word for
 * word (client-setup.test.ts), so the website, the agent guide and the docs give one recipe.
 */
export const CLIENT_SETUP: Record<Client, (url: string) => ClientSetup> = {
  claude: (url) => ({
    line: `claude mcp add --transport http --scope user sidequest ${url}`,
    after: 'Restart Claude Code, then choose /mcp → sidequest → Authenticate.',
  }),
  codex: (url) => ({
    line: `codex mcp add sidequest --url ${url}`,
    fallback: 'codex mcp login sidequest --no-browser',
    after:
      'It opens the browser sign-in and waits five minutes. Then restart Codex; quit the Codex app completely and reopen it.',
  }),
  grok: (url) => ({
    line: `grok mcp add --transport http sidequest ${url}`,
    after: 'Restart Grok, then choose /mcps → sidequest → i.',
  }),
  cursor: (url) => ({
    line: JSON.stringify({ mcpServers: { sidequest: { url } } }),
    after: 'Merge it into .cursor/mcp.json, then choose Settings → MCP → sidequest → Connect.',
  }),
}
