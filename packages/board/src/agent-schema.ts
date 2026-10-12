/** The agent-first clean break is atomic and runs once in each existing object. */
import type { Sql } from './store.ts'
import { migrateUserOpSchema } from './userop-store.ts'

export const RETIRED_FLEET_TABLES = [
  'managed_agents',
  'agent_pairings',
  'agent_approvals',
  'agent_activity',
  'oauth_clients',
  'oauth_requests',
  'oauth_codes',
  'oauth_tokens',
  'oauth_tokens_v2',
  'oauth_token_families_v2',
  'oauth_token_families',
  'agent_gateway_operations',
  'approval_execution',
  'agent_challenges',
  'agent_runtime',
  'sponsor_grants',
] as const

function transition(sql: Sql, name: string, tables: readonly string[], create: () => void): void {
  if (sql.atomic === undefined) throw new Error('Agent schema transition requires atomic storage')
  sql.atomic(() => {
    sql.run('CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)')
    const row = sql.all<{ version: number }>('SELECT version FROM schema_versions WHERE name=?', name)[0]
    if (row?.version === 2) return
    if (row !== undefined) throw new Error('Unexpected agent schema version')
    for (const table of tables) sql.run(`DROP TABLE IF EXISTS ${table}`)
    create()
    sql.run('INSERT INTO schema_versions (name,version) VALUES (?,2)', name)
  })
}

export function migrateAgentSchema(sql: Sql): void {
  transition(sql, 'agents', RETIRED_FLEET_TABLES, () => {
    sql.run(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, operator TEXT NOT NULL, privy_user_id TEXT NOT NULL,
      privy_wallet_id TEXT UNIQUE, address TEXT UNIQUE, name TEXT NOT NULL,
      registry TEXT NOT NULL, agent_id TEXT, chain_id INTEGER NOT NULL,
      state TEXT NOT NULL, last_activity_at INTEGER,
      permissions_json TEXT NOT NULL, onboarding_json TEXT NOT NULL,
      revoke_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    sql.run('CREATE INDEX agents_operator ON agents(operator,created_at)')
    sql.run(`CREATE TABLE grants (
      delegation_hash TEXT PRIMARY KEY, kind TEXT NOT NULL,
      delegator TEXT NOT NULL, delegate TEXT NOT NULL, owner TEXT NOT NULL,
      delegation_json TEXT NOT NULL, signature TEXT, status TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
    sql.run('CREATE INDEX grants_delegator_kind ON grants(delegator,kind,expires_at)')
    sql.run('CREATE TABLE grant_templates (delegation_hash TEXT PRIMARY KEY, spec_json TEXT NOT NULL)')
    sql.run(`CREATE TABLE sponsor_entry_grants (
      operation_id TEXT NOT NULL, delegation_hash TEXT NOT NULL,
      baseline_calls INTEGER NOT NULL, calls INTEGER NOT NULL,
      PRIMARY KEY(operation_id,delegation_hash)
    )`)
    sql.run(`CREATE TABLE sponsor_operator_usage (
      operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      calls INTEGER NOT NULL, publishes INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`)
    sql.run('CREATE INDEX sponsor_operator_usage_owner ON sponsor_operator_usage(owner,created_at)')
    sql.run(`CREATE TABLE agent_operations (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, action_key TEXT NOT NULL,
      board_id TEXT NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL,
      stage TEXT NOT NULL, intent_json TEXT NOT NULL, prepared_json TEXT,
      signatures_json TEXT NOT NULL, sponsor_operation_id TEXT, result_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(agent_id,action_key)
    )`)
    sql.run(`CREATE TABLE agent_sign_requests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, purpose TEXT NOT NULL,
      wallet_id TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT,
      created_at INTEGER NOT NULL, UNIQUE(agent_id,purpose)
    )`)
    sql.run(`CREATE TABLE agent_operation_steps (
      operation_id TEXT NOT NULL, name TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(operation_id,name)
    )`)
    sql.run(`CREATE TABLE approvals (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT NOT NULL,
      decision_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
    )`)
    sql.run(`CREATE TABLE agent_oauth_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    sql.run(`CREATE TABLE agent_oauth_requests (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL, state TEXT NOT NULL, board_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL, resource TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
    sql.run(`CREATE TABLE agent_oauth_codes (
      hash TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    )`)
    sql.run(`CREATE TABLE agent_oauth_families (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      board_id TEXT NOT NULL, scopes_json TEXT NOT NULL, resource TEXT NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
    )`)
    sql.run(`CREATE TABLE agent_oauth_tokens (
      hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, kind TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    )`)
  })
  createAgentProfiles(sql)
  createSetupOAuth(sql)
  migrateUserOpSchema(sql)
}

function createSetupOAuth(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS agent_oauth_setup_codes (
    hash TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, operator TEXT NOT NULL,
    requested_scopes_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS agent_oauth_setup_families (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, operator TEXT NOT NULL,
    board_id TEXT NOT NULL, scopes_json TEXT NOT NULL, requested_scopes_json TEXT NOT NULL,
    resource TEXT NOT NULL, agent_id TEXT, revoked_at INTEGER, created_at INTEGER NOT NULL
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS agent_oauth_setup_tokens (
    hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL, consumed_at INTEGER
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS agent_setup_operators (
    operator TEXT PRIMARY KEY, privy_user_id TEXT NOT NULL, verified_at INTEGER NOT NULL
  )`)
  // When each connection last called hosted MCP, for the operator's connections list (ADR-0021).
  sql.run(`CREATE TABLE IF NOT EXISTS agent_oauth_activity (
    family_id TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS agent_setup_connections (
    agent_key TEXT NOT NULL, family_id TEXT NOT NULL UNIQUE, board_id TEXT NOT NULL,
    resource TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(agent_key,family_id)
  )`)
}

function createAgentProfiles(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_key TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    tagline TEXT NOT NULL DEFAULT '',
    avatar_key TEXT,
    avatar_prompt TEXT,
    generations_day TEXT,
    generations INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL CHECK(updated_by IN ('owner','agent'))
  )`)
}

/** The former fleet object retires its authority records without receiving any new management tables. */
export function retireFleetSchema(sql: Sql): void {
  transition(sql, 'agents', RETIRED_FLEET_TABLES, () => {})
}
