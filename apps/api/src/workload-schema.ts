import type { Sql } from '@sidequest/board'

/** Additive SQLite migration in the existing ADR-0013 management object, never D1 or the retired fleet. */
export function migrateWorkloadSchema(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS agent_workload_policies (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, policy_json TEXT NOT NULL,
    scopes_json TEXT NOT NULL, resource TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, deleted_at INTEGER
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS agent_workload_connections (
    family_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL
  )`)
  sql.run(`CREATE TABLE IF NOT EXISTS agent_workload_assertions (
    hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  )`)
}

export function workloadOidcEnabled(bindings: Record<string, unknown>): boolean {
  return bindings.WORKLOAD_OIDC_ENABLED === '1'
}

/** Existing OAuth families keep their behavior; workload families additionally follow the switch and live policy. */
export function workloadConnectionAllowed(sql: Sql, familyId: string, enabled: boolean): boolean {
  const link = sql.all<{ policy_id: string }>(
    'SELECT policy_id FROM agent_workload_connections WHERE family_id=?',
    familyId,
  )[0]
  if (link === undefined) return true
  return (
    enabled &&
    sql.all('SELECT id FROM agent_workload_policies WHERE id=? AND enabled=1 AND deleted_at IS NULL', link.policy_id)
      .length > 0
  )
}
