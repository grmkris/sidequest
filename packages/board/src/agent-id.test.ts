import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { canonicalAgentId, storedAgentId } from './agent-id.ts'
import { fromNodeSqlite, migrate } from './store.ts'

describe('canonicalAgentId', () => {
  it('accepts decimal strings and safe integers as one canonical string', () => {
    expect(canonicalAgentId('10415')).toBe('10415')
    expect(canonicalAgentId(10415)).toBe('10415')
    expect(canonicalAgentId(10415.0)).toBe('10415')
    expect(canonicalAgentId(' 007 ')).toBe('7')
  })
  it('refuses as invalid, never as an internal error', () => {
    for (const bad of ['10415.0', '1e4', '0', '', '-1', 10415.5, 2 ** 60, '1'.repeat(80)])
      expect(() => canonicalAgentId(bad)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
})

describe('storedAgentId', () => {
  it('reads legacy REAL text rows as their integer', () => {
    expect(storedAgentId('10415.0')).toBe('10415')
    expect(storedAgentId('10399')).toBe('10399')
    expect(storedAgentId('10415.5')).toBeUndefined()
    expect(storedAgentId('abc')).toBeUndefined()
  })
})

describe('migrate', () => {
  it('rewrites REAL-text agent ids left by numeric binds (prod job 17)', () => {
    const database = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(database)
    migrate(sql)
    // A REAL bound into a TEXT column is stored as "10415.0", exactly what the Workers binding produced.
    database.exec(
      "INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES ('a', 't', '0x33d6112f2F3BCD2a476bD9C13208E4C632bE2d0a', CAST(10415 AS REAL), '', 0)",
    )
    database
      .prepare('INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('b', 't', '0xF3a5163FE4BE20442E4fED1f34A978Cad123B7B4', '10399', '', 0)
    expect(sql.all<{ agent_id: string }>("SELECT agent_id FROM applications WHERE id = 'a'")[0]!.agent_id).toBe(
      '10415.0',
    )
    migrate(sql)
    expect(sql.all<{ id: string; agent_id: string }>('SELECT id, agent_id FROM applications ORDER BY id')).toEqual([
      { id: 'a', agent_id: '10415' },
      { id: 'b', agent_id: '10399' },
    ])
    database.close()
  })
})
