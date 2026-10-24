import { type Hex } from 'viem'
import * as sdk from '../../../src/index.ts'
import { ORIGIN } from './guards.ts'
import { Runtime, type Proof } from './runtime.ts'

interface Status {
  revocation: { hostedAccessStopped?: boolean; onchainPermissionsDisabled?: boolean }
  grants: Array<{ hash: Hex; status: string }>
}

/**
 * Revocation under a relay outage. Keeps reads for receipt verification; aborts the real revoke route without
 * replacing responses. Hosted access must stop at once, on-chain disablement must stay unconfirmed until the relay
 * returns, and every "disabled" status must then match chain state. (The browser Privy-owner/RPC recovery sweep this
 * case used to include went with Explore's emergency-recovery panel on 6 Oct 2026.)
 */
export async function outage(runtime: Runtime): Promise<Proof> {
  await runtime.login()
  const { browser, chain } = runtime
  const agent = runtime.agent
  const coding = await runtime.coding()
  await browser.page.goto(`${ORIGIN}/agent/${agent.agent_id}?tab=manage`)
  const card = browser.page.locator('article').filter({ hasText: agent.name })
  await card.waitFor()
  let blocked = 0
  // Keep a network route: this case must abort the real revoke request while reads continue and no response is replaced.
  await browser.context.route('**/api/**', async (route) => {
    const request = route.request()
    if (new URL(request.url()).pathname.endsWith('/revoke')) {
      blocked++
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
  let status = await browser.api<Status>(`/api/agents/${agent.id}`)
  const stoppedBefore = status.revocation.hostedAccessStopped === true
  if (!stoppedBefore) {
    await card.getByRole('button', { name: 'Stop hosted access and revoke', exact: true }).click()
    await card.getByText(/On-chain disablement is incomplete/).waitFor({ timeout: 60_000 })
    status = await browser.api<Status>(`/api/agents/${agent.id}`)
  }
  if (status.revocation.hostedAccessStopped !== true || status.revocation.onchainPermissionsDisabled === true)
    throw new Error('P8_REVOKE_CONFIRMATION_BOUNDARY_BROKEN')
  await coding.assertRevoked()
  if (/On-chain permissions:\s*Disabled/i.test(await card.innerText()))
    throw new Error('P8_DISABLED_BEFORE_CHAIN_CONFIRMATION')
  if (blocked === 0 && !stoppedBefore) throw new Error('P8_RELAY_FAULT_NOT_OBSERVED')
  await browser.context.unrouteAll({ behavior: 'wait' })
  await chain.reserve('a06/revoke', 3_000_000n)
  const final = await browser.api<Status>(`/api/agents/${agent.id}/revoke`, {})
  if (final.revocation.onchainPermissionsDisabled !== true) throw new Error('P8_REVOKE_REMAINS_UNCONFIRMED')
  const recovery = await browser.api<{ grants: Array<{ hash: Hex; status: string }> }>(
    `/api/agents/${agent.id}/recovery`,
  )
  for (const grant of recovery.grants) {
    if (grant.status === 'live' || (grant.status === 'disabled' && !(await sdk.isDisabled(chain.ctx, grant.hash))))
      throw new Error('P8_DISABLED_STATUS_WITHOUT_CHAIN_CONFIRMATION')
  }
  const hashes = await browser.cachedHashes()
  await chain.finish('a06/revoke', hashes)
  await browser.page.reload()
  await card.getByText(/Disabled · confirmed receipts/).waitFor({ timeout: 30_000 })
  return {
    checks: [
      'actual Codex OAuth token refused immediately after stop-access',
      'grants remain unconfirmed while the revoke route is aborted',
      'restored relay confirms disablement; every disabled status matches chain state',
    ],
    txHashes: hashes,
    details: {
      hostedAccessStopped: true,
      onchainPermissionsDisabled: true,
      faultInjection: 'Playwright network route aborts; no replacement responses',
    },
  }
}
