/** Shared SIWE role runner. Arbitration remains the default. */
import { Schema } from 'effect'
import * as sdk from '@sidequest/sdk'
import { runArbiterPass } from './arbiter-run.ts'
import { runRoleLoop } from './loop.ts'
import { moderateOnce } from './moderator.ts'
import { maintainOnce } from './maintainer.ts'
import { parseRoleArguments, roleEnvironment, type RoleClient } from './role.ts'
import { accountFromPrivateKey, arbiterAccounts, boardUrls } from './runtime.ts'

const args = parseRoleArguments(process.argv.slice(2))
const env = process.env
const config = roleEnvironment(args.role, env)
const endpoint = { baseUrl: config.modelBaseUrl, model: config.model, apiKey: config.modelApiKey }
const network = Schema.decodeUnknownSync(Schema.Literals(['monad-mainnet', 'monad-testnet']))(
  env.NETWORK ?? 'monad-testnet',
)
const accounts =
  args.role === 'arbiter'
    ? arbiterAccounts(sdk.deployment(network), env)
    : [accountFromPrivateKey(args.role === 'maintainer' ? 'MAINTAINER_PRIVATE_KEY' : 'MODERATOR_PRIVATE_KEY', env)]
const clients = boardUrls(env).flatMap((url) =>
  accounts.map((account) => ({
    account,
    board: sdk.boardClient(url),
    cursorKey: `${url}:${account.address.toLowerCase()}`,
  })),
)
const log = (message: string) => console.log(`[${args.role} ${new Date().toISOString().slice(11, 19)}] ${message}`)
let skipped = false

const pass = async (client: RoleClient): Promise<void> => {
  if (args.role === 'arbiter') {
    const result = await runArbiterPass(client, { network, endpoint, env, log })
    skipped ||= result
  } else if (args.role === 'maintainer') {
    await maintainOnce({
      board: client.board,
      endpoint,
      stateFile: config.cursorFile!,
      shipSince: config.shipSince!,
      log,
    })
  } else {
    await moderateOnce({
      board: client.board,
      endpoint,
      cursorFile: config.cursorFile!,
      cursorKey: client.cursorKey!,
      log,
    })
  }
}

await runRoleLoop({ clients, once: args.once, intervalSeconds: config.intervalSeconds, pass, log })
if (args.once) process.exit(skipped ? 2 : 0)
