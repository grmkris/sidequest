import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AgentRoles } from './agent-roles.ts'
import { AgentStore, agentOperationId, agentRoles } from './agents.ts'
import { fromNodeSqlite } from './store.ts'

const operator = '0x1111111111111111111111111111111111111111'
const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const agents = new AgentStore(fromNodeSqlite(db), () => 1_800_000_000)
  const agent = agents.create({
    id: 'quill',
    operator,
    privyUserId: 'did:privy:u',
    name: 'Quill',
    registry: '0x2222222222222222222222222222222222222222',
    chainId: 10143,
  })
  return { agents, agent, roles: new AgentRoles(agents) }
}

it('an agent holds both roles until its operator changes them, and unreadable roles grant none', () => {
  const { agents, agent } = fixture()
  expect(agents.roles(agent.id)).toEqual(['work', 'hire'])
  expect(agents.setRoles(agent.id, ['hire'])).toEqual(['hire'])
  expect(agents.addRole(agent.id, 'work')).toEqual(['work', 'hire'])
  expect(agentRoles({ permissions_json: 'not json' })).toEqual([])
  expect(agentRoles({ permissions_json: '["work"]' })).toEqual([])
  expect(agents.begin(agent.id, 'key-1', 'board', 'tool', {}).id).toBe(agentOperationId(agent.id, 'key-1'))
})

it('a role request waits for the operator, and approval adds the role and confirms the same request', () => {
  const { agents, agent, roles } = fixture()
  agents.setRoles(agent.id, ['work'])
  const asked = roles.request(agent, 'board', 'ask-hire', { role: 'hire', reason: 'post a logo job' })
  expect(asked).toMatchObject({ status: 'approval', approval: { kind: 'role', status: 'pending' } })
  expect(roles.request(agent, 'board', 'ask-hire', { role: 'hire', reason: 'post a logo job' }).status).toBe('approval')
  expect(() => roles.request(agent, 'board', 'ask-hire', { role: 'work' })).toThrow('different action')
  // SAFETY: an 'approval' result always carries its approval row.
  const approval = (asked as { approval: { id: string } }).approval
  expect(() => roles.decide(agents.approval(approval.id), '0x9999999999999999999999999999999999999999', true)).toThrow(
    'another operator',
  )
  expect(roles.decide(agents.approval(approval.id), operator, true).status).toBe('executed')
  expect(agents.roles(agent.id)).toEqual(['work', 'hire'])
  expect(roles.request(agent, 'board', 'ask-hire', { role: 'hire', reason: 'post a logo job' })).toMatchObject({
    status: 'confirmed',
    result: { role: 'hire', roles: ['work', 'hire'] },
  })
})

it('a rejected request stays rejected, and a role already held confirms without asking', () => {
  const { agents, agent, roles } = fixture()
  agents.setRoles(agent.id, [])
  const asked = roles.request(agent, 'board', 'ask-work', { role: 'work' })
  // SAFETY: an 'approval' result always carries its approval row.
  const approval = (asked as { approval: { id: string } }).approval
  expect(roles.decide(agents.approval(approval.id), operator, false).status).toBe('rejected')
  expect(agents.roles(agent.id)).toEqual([])
  expect(roles.request(agent, 'board', 'ask-work', { role: 'work' }).status).toBe('rejected')
  agents.setRoles(agent.id, ['hire'])
  expect(roles.request(agent, 'board', 'ask-hire', { role: 'hire' })).toMatchObject({ status: 'confirmed' })
})

it('a pending request is answered when the operator grants the role on the agent page instead', () => {
  const { agents, agent, roles } = fixture()
  agents.setRoles(agent.id, [])
  const asked = roles.request(agent, 'board', 'ask-hire', { role: 'hire' })
  agents.addRole(agent.id, 'hire')
  expect(roles.request(agent, 'board', 'ask-hire', { role: 'hire' })).toMatchObject({ status: 'confirmed' })
  // SAFETY: an 'approval' result always carries its approval row.
  expect(agents.approval((asked as { approval: { id: string } }).approval.id).status).toBe('executed')
})
