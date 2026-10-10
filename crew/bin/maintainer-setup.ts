#!/usr/bin/env bun
/**
 * One-off setup for the Commons maintainer (the CTO bot): the dev faucet's SIDE and mUSD drip, then 200 SIDE staked
 * to itself, so its roadmap proposals meet the 100 SIDE floor. Every send is journaled, so a rerun sends nothing new.
 *
 *   bun crew/bin/maintainer-setup.ts run      (container, once; MAINTAINER_PRIVATE_KEY from the dev env)
 */
import { erc20Abi, parseEther } from 'viem'
import { ctx, log, now, sdk, signerFor, store, v1 } from './activity.ts'

async function setup() {
  const { wallet, account } = signerFor('maintainer')
  const { journal } = store<Record<string, never>>('maintainer-setup', {})
  const stake = parseEther('200')
  if ((await sdk.nextDripAt(ctx, account.address)) <= now())
    await journal.send('setup/drip', wallet, { ...sdk.dripCall(ctx, account.address), value: '0' })
  await journal.contract('setup/approve-side', wallet, ctx.deployment.factory, erc20Abi, 'approve', [v1.vault, stake])
  await journal.contract('setup/stake', wallet, v1.vault, sdk.stakeVaultAbi, 'delegate', [account.address, stake])
  log('maintainer', 'setup', { address: account.address, staked: '200 SIDE' })
}

if (process.argv[2] === 'run') await setup()
else console.log('usage: bun crew/bin/maintainer-setup.ts run')
