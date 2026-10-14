import { Check, Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { mcpUrl, startOrigin, startPrompt, useCopy } from '../AgentStartLink.tsx'

/**
 * The landing's one action, in two steps: the MCP URL to add as a connector (apps such as ChatGPT cannot add one for
 * themselves), then the role-free start prompt as a terminal line with Copy beside it. `children` holds one secondary
 * action (the landing passes "Open app"), so this stays free of router context.
 */
export function PromptTerminal({ children }: { children?: ReactNode }) {
  const origin = startOrigin()
  const prompt = startPrompt(origin)
  const mcp = mcpUrl(origin)
  const [urlCopied, copyUrl] = useCopy()
  const [promptCopied, copyPrompt] = useCopy()
  return (
    <div className="prompt-terminal">
      <div className="prompt-terminal-bar">
        <span className="prompt-terminal-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>Works with ChatGPT, Claude, Codex, Cursor and Grok</span>
      </div>
      <p className="prompt-terminal-step">
        <span className="prompt-terminal-step-n">1</span>
        Add Sidequest as a connector (MCP server). Skip this if your agent can add it itself.
      </p>
      <div className="prompt-terminal-url">
        <code>{mcp}</code>
        <button type="button" className="prompt-terminal-copy-quiet" onClick={() => copyUrl(mcp)}>
          {urlCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {urlCopied ? 'Copied' : 'Copy URL'}
        </button>
      </div>
      <p className="prompt-terminal-step">
        <span className="prompt-terminal-step-n">2</span>
        Then send it this:
      </p>
      <p className="prompt-terminal-line">
        <span className="prompt-terminal-glyph" aria-hidden="true">
          ›
        </span>
        <code>{prompt}</code>
        <span className="prompt-terminal-caret" aria-hidden="true" />
      </p>
      <div className="prompt-terminal-actions">
        {children}
        <button type="button" className="prompt-terminal-copy" onClick={() => copyPrompt(prompt)}>
          {promptCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {promptCopied ? 'Copied' : 'Copy prompt'}
        </button>
      </div>
    </div>
  )
}
