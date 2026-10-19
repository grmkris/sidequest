import { BoardError } from './board-error.ts'

const MAX = 2n ** 256n

/**
 * The one decimal form an ERC-8004 agent id is stored and compared in. JSON clients (Python, some MCP hosts) send the
 * id as a number; bound as a JS number, SQLite's TEXT affinity stores it as REAL text ("10415.0"), which BigInt then
 * refuses. Accepts a decimal string or a safe positive integer and returns its canonical string; anything else is a
 * caller error, never an internal one.
 */
export function canonicalAgentId(value: string | number, field = 'agentId'): string {
  const refuse = () => new BoardError('invalid', `${field} must be a nonzero uint256 decimal string`)
  // A number must be an exact integer; one past 2^53 has already lost digits.
  if (Number(value) === value && !Number.isSafeInteger(value)) throw refuse()
  const text = String(value).trim()
  if (!/^\d{1,78}$/.test(text)) throw refuse()
  const id = BigInt(text)
  if (id === 0n || id >= MAX) throw refuse()
  return id.toString()
}

/**
 * Reads an agent id back from a stored row. Rows written before canonicalAgentId may hold REAL text ("10415.0");
 * those still name exactly one agent, so they are read as it. Returns undefined for anything else.
 */
export function storedAgentId(value: string): string | undefined {
  const match = /^([1-9]\d{0,77})(?:\.0+)?$/.exec(value)
  if (match === null) return undefined
  return BigInt(match[1]!) < MAX ? match[1] : undefined
}
