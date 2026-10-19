/**
 * The board's off-chain records (spec §3 "Off-chain progress"): tasks and their frozen offers, applications,
 * signed selections, activation and submission preparations, sign-in sessions, and the durable operation records of
 * R114-07. Chain facts (funding, activation, settlement) are never stored as truth here: the service reads them
 * from the chain every time.
 *
 * Runs on any synchronous SQLite: Cloudflare Durable Object storage in production (`fromDurableObjectSql`), Node's
 * `node:sqlite` in tests (`fromNodeSqlite`).
 */
export type SqlValue = string | number | null

export interface Sql {
  all<T>(query: string, ...params: SqlValue[]): T[]
  run(query: string, ...params: SqlValue[]): void
  atomic?<T>(write: () => T): T
}

/** Cloudflare's `SqlStorage` (`ctx.storage.sql`). */
export function fromDurableObjectSql(
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] }
  },
  atomic?: <T>(write: () => T) => T,
): Sql {
  return {
    ...(atomic === undefined ? {} : { atomic }),
    all: <T>(query: string, ...params: SqlValue[]) => sql.exec(query, ...params).toArray() as T[],
    run: (query, ...params) => {
      sql.exec(query, ...params).toArray()
    },
  }
}

/** Node's `DatabaseSync` from `node:sqlite`. */
export function fromNodeSqlite(db: {
  prepare(query: string): { all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }
}): Sql {
  return {
    atomic: <T>(write: () => T): T => {
      db.prepare('SAVEPOINT board_write').run()
      try {
        const result = write()
        db.prepare('RELEASE board_write').run()
        return result
      } catch (error) {
        db.prepare('ROLLBACK TO board_write').run()
        db.prepare('RELEASE board_write').run()
        throw error
      }
    },
    all: <T>(query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as T[],
    run: (query, ...params) => {
      db.prepare(query).run(...params)
    },
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ruling_attempts (
    task_id TEXT NOT NULL, nonce TEXT NOT NULL, record_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, nonce)
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    stack TEXT NOT NULL,
    terms_json TEXT NOT NULL,
    terms_hash TEXT NOT NULL UNIQUE,
    job_id TEXT,
    publish_tx TEXT,
    from_block INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    screening_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pools (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    factory TEXT NOT NULL,
    salt TEXT NOT NULL,
    pool TEXT NOT NULL,
    curator TEXT NOT NULL,
    token TEXT NOT NULL,
    goal TEXT NOT NULL,
    pledge_deadline INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, worker)
  )`,
  `CREATE TABLE IF NOT EXISTS selections (
    task_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    application_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    activate_by INTEGER NOT NULL,
    signature TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, nonce)
  )`,
  `CREATE TABLE IF NOT EXISTS activation_preps (
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    nonce TEXT NOT NULL,
    budget_nonce TEXT NOT NULL,
    budget_deadline INTEGER NOT NULL,
    PRIMARY KEY (task_id, worker)
  )`,
  `CREATE TABLE IF NOT EXISTS deliverables (
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    deliverable_hash TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, deliverable_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS reasons (
    hash TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operation_receipts (
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (chain_id, tx_hash, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS siwe_nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    deliverable_hash TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    budget_nonce TEXT NOT NULL,
    submit_nonce TEXT NOT NULL,
    budget_sig TEXT,
    submit_sig TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, worker, deliverable_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS onchain_submissions (
    task_id TEXT PRIMARY KEY,
    deliverable_hash TEXT NOT NULL,
    tx_hash TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    submission_hash TEXT NOT NULL,
    verifier TEXT NOT NULL,
    conclusion INTEGER NOT NULL,
    tested_sha TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Quote-to-hire (ADR-0004): a request is a board record with nothing escrowed; quotes are private to the
  // publisher and the bidder until the publisher picks one and publishes the ordinary offer.
  `CREATE TABLE IF NOT EXISTS quote_requests (
    id TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    stack TEXT NOT NULL,
    request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    quote_deadline INTEGER NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    note TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (request_id, worker)
  )`,
  `CREATE TABLE IF NOT EXISTS statements (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    author TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // One decision per dispute (task, disputedAt): the first recorded decision is the only one the board relays.
  `CREATE TABLE IF NOT EXISTS rulings (
    task_id TEXT NOT NULL,
    disputed_at INTEGER NOT NULL,
    arbitrator TEXT NOT NULL,
    runner TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    for_worker INTEGER NOT NULL,
    slash_loser INTEGER NOT NULL,
    reason_hash TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    signature TEXT,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, disputed_at)
  )`,
  // Which arbiter runner is active for an arbitrator key (plan B2.4: one runner at a time).
  `CREATE TABLE IF NOT EXISTS arbiter_leases (
    arbitrator TEXT PRIMARY KEY,
    runner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // Execution budget (ADR-0009). One delegation per hire, from the creator's account to the activated worker: the
  // board keeps what it prepared, the creator's signature once granted, and the draws it prepared or saw on-chain.
  // The chain's enforcers hold the cap; these rows are records, never the limit.
  `CREATE TABLE IF NOT EXISTS budget_delegations (
    task_id TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    worker TEXT,
    delegation_json TEXT,
    delegation_hash TEXT,
    signature TEXT,
    created_at INTEGER NOT NULL,
    live_at INTEGER,
    ended_at INTEGER,
    ended_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS budget_draws (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    amount TEXT,
    call_data TEXT,
    redeem_data TEXT,
    note TEXT NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_sessions (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hosted_idempotency (
    caller TEXT NOT NULL,
    operation TEXT NOT NULL,
    action_key TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (caller, operation, action_key)
  )`,
]

/** Columns added after a table first shipped; applied additively (never a destructive change to board data). */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, type: string]> = [
  ['tasks', 'screening_json', 'TEXT'],
  // Which model and prompt produced a ruling (R114-08), when a harness reports them.
  ['rulings', 'model', 'TEXT'],
  ['rulings', 'prompt_version', 'TEXT'],
  // A quote's declared execution costs, apart from its price.
  ['quotes', 'expected_costs_json', 'TEXT'],
  // Deliverables anywhere (ADR-0006): the descriptor and the one-time submission check. Legacy rows are git.
  ['deliverables', 'kind', 'TEXT'],
  ['deliverables', 'descriptor_json', 'TEXT'],
  ['deliverables', 'check_json', 'TEXT'],
  ['candidates', 'kind', 'TEXT'],
  ['candidates', 'descriptor_json', 'TEXT'],
  ['candidates', 'check_json', 'TEXT'],
  ['tasks', 'pool_id', 'TEXT'],
  // ADR-0019: the agent that posted (its ERC-8004 id), when the board resolved one at posting time.
  ['tasks', 'creator_agent_id', 'TEXT'],
  ['quote_requests', 'creator_agent_id', 'TEXT'],
  ['quote_requests', 'invited_agent', 'TEXT'],
  ['quote_requests', 'invited_wallet', 'TEXT'],
]

/**
 * ADR-0005's execution budgets (a Privy signer over creator funds, a board ledger as the cap) are gone (ADR-0009):
 * their tables are dropped, and the tasks whose frozen offer carries one of their budget shapes are removed with
 * everything recorded against them (decided 29 Sep 2026: not migrated). A no-op once done.
 */
const RETIRED_TABLES = ['budget_wallets', 'budget_grants', 'budget_spends']
const RETIRED_TASKS = `SELECT id FROM tasks WHERE json_extract(terms_json, '$.executionBudget') IS NOT NULL
  AND coalesce(json_extract(terms_json, '$.executionBudget.kind'), '') NOT IN ('advance', 'call')`
const TASK_TABLES = [
  'pools',
  'applications',
  'selections',
  'activation_preps',
  'deliverables',
  'reasons',
  'operations',
  'candidates',
  'onchain_submissions',
  'evidence',
  'statements',
  'rulings',
  'budget_delegations',
  'budget_draws',
]

function dropRetiredBudgets(sql: Sql): void {
  for (const table of RETIRED_TABLES) sql.run(`DROP TABLE IF EXISTS ${table}`)
  if (sql.all(`${RETIRED_TASKS} LIMIT 1`).length === 0) return
  for (const table of TASK_TABLES) sql.run(`DELETE FROM ${table} WHERE task_id IN (${RETIRED_TASKS})`)
  sql.run(`DELETE FROM quotes WHERE request_id IN (SELECT id FROM quote_requests WHERE task_id IN (${RETIRED_TASKS}))`)
  sql.run(`DELETE FROM quote_requests WHERE task_id IN (${RETIRED_TASKS})`)
  sql.run(`DELETE FROM tasks WHERE id IN (${RETIRED_TASKS})`)
}

export function migrate(sql: Sql): void {
  for (const statement of SCHEMA) sql.run(statement)
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
    if (!columns.includes(column)) sql.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  dropRetiredBudgets(sql)
  canonicalizeAgentIds(sql)
}

/**
 * Agent ids bound as JS numbers landed as REAL text ("10415.0") in TEXT columns, which BigInt refuses (select_worker
 * failed with reason internal on prod job 17). Rewrites them to their integer text. A no-op once done.
 */
const AGENT_ID_TABLES = ['applications', 'selections', 'candidates', 'quotes'] as const
function canonicalizeAgentIds(sql: Sql): void {
  for (const table of AGENT_ID_TABLES)
    sql.run(
      `UPDATE ${table} SET agent_id = substr(agent_id, 1, instr(agent_id, '.') - 1)
       WHERE agent_id GLOB '[1-9]*.0' AND rtrim(substr(agent_id, instr(agent_id, '.') + 1), '0') = ''
         AND substr(agent_id, 1, instr(agent_id, '.') - 1) NOT GLOB '*[^0-9]*'`,
    )
}

export interface TaskRow {
  id: string
  creator: string
  stack: string
  terms_json: string
  terms_hash: string
  job_id: string | null
  publish_tx: string | null
  from_block: number
  created_at: number
  screening_json: string | null
  /** ADR-0019: the posting agent, resolved when the offer was frozen; null for older rows and plain wallets. */
  creator_agent_id?: string | null
}

export interface ApplicationRow {
  id: string
  task_id: string
  worker: string
  agent_id: string
  note: string
  created_at: number
}

export interface SelectionRow {
  task_id: string
  nonce: string
  application_id: string
  worker: string
  agent_id: string
  activate_by: number
  signature: string | null
  created_at: number
}

export interface OperationRow {
  id: string
  task_id: string
  kind: string
  actor: string
  status: 'prepared' | 'submitted' | 'confirmed' | 'failed'
  tx_hash: string | null
  detail: string | null
  created_at: number
  updated_at: number
}

export interface RulingRow {
  task_id: string
  disputed_at: number
  arbitrator: string
  runner: string
  bundle_hash: string
  for_worker: number
  slash_loser: number
  reason_hash: string
  deadline: number
  nonce: string
  signature: string | null
  tx_hash: string | null
  created_at: number
  model: string | null
  prompt_version: string | null
}

export interface QuoteRequestRow {
  id: string
  creator: string
  stack: string
  request_json: string
  request_hash: string
  quote_deadline: number
  task_id: string | null
  created_at: number
  /** ADR-0019: the posting agent, resolved when the request was made; null for older rows and plain wallets. */
  creator_agent_id?: string | null
  /** The invited ERC-8004 agent and its resolved wallet, when this request names one. */
  invited_agent?: string | null
  invited_wallet?: string | null
}

export interface QuoteRow {
  id: string
  request_id: string
  worker: string
  agent_id: string
  token: string
  amount: string
  note: string
  quote_hash: string
  created_at: number
  expected_costs_json: string | null
}

export type BudgetStatus = 'promised' | 'live' | 'revoked' | 'ended'

export interface BudgetDelegationRow {
  task_id: string
  creator: string
  kind: 'advance' | 'call'
  status: BudgetStatus
  /** The activated worker the delegation names; null until the creator prepares the grant. */
  worker: string | null
  /** The unsigned delegation (`delegation.ts`), salt as a decimal string. */
  delegation_json: string | null
  delegation_hash: string | null
  /** The creator's EIP-712 signature once granted. */
  signature: string | null
  created_at: number
  live_at: number | null
  ended_at: number | null
  ended_reason: string | null
}

export type BudgetDrawStatus = 'prepared' | 'confirmed' | 'failed'

export interface BudgetDrawRow {
  id: string
  task_id: string
  worker: string
  /** Base units of the advance token, or a call's native value; null when a direct redemption's value is unknown. */
  amount: string | null
  /** A call draw's calldata. */
  call_data: string | null
  /** The `redeemDelegations` calldata the board prepared: a reported transaction with exactly this input is this draw. */
  redeem_data: string | null
  note: string
  status: BudgetDrawStatus
  tx_hash: string | null
  created_at: number
  updated_at: number
}
