import { ORIGIN } from './guards.ts'
import { Runtime, text, type Proof } from './runtime.ts'

export async function clients(runtime: Runtime): Promise<Proof> {
  await runtime.login()
  const client = await runtime.coding('fresh')
  const result = await client.call('get_instructions', { role: 'connector' }, 'a08-instructions')
  let instructions: string
  try {
    instructions = text(result.output)
  } catch {
    throw new Error('P8_FRESH_INSTRUCTIONS_MISSING')
  }
  if (
    result.item.result?.isError === true ||
    !instructions.includes('operationKey') ||
    !instructions.includes('Last activity is not a health check or proof of paid work.')
  )
    throw new Error('P8_FRESH_INSTRUCTIONS_MISSING')
  await runtime.browser.page.goto(`${ORIGIN}/agent/${runtime.agent.agent_id}?tab=manage`)
  const card = runtime.browser.page.locator('article').filter({ hasText: runtime.agent.name })
  await card.getByText(/Last activity:/).waitFor({ timeout: 30_000 })
  if (!/Last activity:[\s\S]*not a health signal/i.test(await card.innerText()))
    throw new Error('P8_LAST_ACTIVITY_IS_LIVENESS')
  return {
    checks: [
      'fresh isolated Codex client retrieves connector instructions',
      'Last activity explicitly disclaims liveness',
    ],
    txHashes: [],
    details: {
      client: 'fresh Codex with independent OAuth credentials',
    },
  }
}
