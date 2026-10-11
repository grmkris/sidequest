import { describe, expect, it } from 'vitest'
import type { DirectoryAgent } from '@sidequest/sdk'
import type { ManagedAgent } from './api.ts'
import { positionLabel } from './position-label.ts'

const owner = '0x0000000000000000000000000000000000000001'
const account = '0x0000000000000000000000000000000000000002'
const managed = (
  address: string | null,
  agent_id: string | null,
  name: string,
): Pick<ManagedAgent, 'address' | 'agent_id' | 'name'> => ({ address, agent_id, name })
const directory = (
  wallet: DirectoryAgent['wallet'],
  agentId: string,
  name: string,
): Pick<DirectoryAgent, 'wallet' | 'agentId' | 'profile'> => ({
  wallet,
  agentId,
  profile: { name, description: '', services: [] },
})

describe('positionLabel', () => {
  it('labels the signed-in wallet first', () => {
    expect(
      positionLabel(owner, {
        owner,
        managed: [managed(owner, '42', 'Managed')],
        directory: [directory(owner, '7', 'Listed')],
        walletAgents: ['19'],
      }),
    ).toEqual({
      kind: 'wallet',
      name: 'Your wallet',
      hint: 'Your own stake: deposits for jobs you post',
    })
  })

  it('prefers a managed agent and includes its id and route', () => {
    expect(
      positionLabel(account, {
        owner,
        managed: [managed(account, '42', 'Scout')],
        directory: [directory(account, '7', 'Listed')],
        walletAgents: ['19'],
      }),
    ).toEqual({
      kind: 'agent',
      name: 'Scout',
      hint: 'Agent ID 42',
      agentId: '42',
      href: '/agent/42',
    })
  })

  it('uses a directory name before the wallet lookup', () => {
    expect(
      positionLabel(account, {
        owner,
        managed: [managed(owner, '42', 'Another agent')],
        directory: [directory(account, '7', 'Listed agent')],
        walletAgents: ['8'],
      }),
    ).toEqual({ kind: 'agent', name: 'Listed agent', agentId: '7', href: '/agent/7' })
  })

  it('falls back to the indexed Agent ID, then the short address', () => {
    expect(positionLabel(account, { walletAgents: ['19'] })).toEqual({
      kind: 'agent',
      name: 'Agent ID 19',
      agentId: '19',
      href: '/agent/19',
    })
    expect(positionLabel(account)).toEqual({ kind: 'address', name: '0x0000…0002' })
  })

  it('compares wallet addresses without regard to case', () => {
    const lower = '0xabababababababababababababababababababab'
    const upper = '0xABABABABABABABABABABABABABABABABABABABAB'
    expect(positionLabel(upper, { owner: lower }).name).toBe('Your wallet')
    expect(positionLabel(upper, { managed: [managed(lower, '42', 'Scout')] }).name).toBe('Scout')
    expect(positionLabel(upper, { directory: [directory(lower, '7', 'Listed')] }).name).toBe('Listed')
  })

  it('ignores missing addresses and agents behind other wallets', () => {
    expect(
      positionLabel(account, {
        owner,
        managed: [managed(null, '42', 'Unprovisioned'), managed(owner, '8', 'Another wallet')],
        directory: [directory(owner, '7', 'Other listing')],
        walletAgents: [],
      }),
    ).toEqual({ kind: 'address', name: '0x0000…0002' })
  })

  it('keeps managed names while registration is incomplete without an invalid agent link', () => {
    expect(positionLabel(account, { managed: [managed(account, null, 'New agent')] })).toEqual({
      kind: 'agent',
      name: 'New agent',
      hint: 'Managed agent',
    })
  })

  it('uses Agent IDs instead of blank managed or directory names', () => {
    expect(positionLabel(account, { managed: [managed(account, '42', '  ')] }).name).toBe('Agent ID 42')
    expect(positionLabel(account, { directory: [directory(account, '7', '')] }).name).toBe('Agent ID 7')
    expect(positionLabel(account, { managed: [managed(account, '42', '  Scout  ')] }).name).toBe('Scout')
  })

  it('uses the first indexed identity consistently when a wallet has worked as multiple agents', () => {
    expect(positionLabel(account, { walletAgents: ['19', '20'] }).name).toBe('Agent ID 19')
  })
})
