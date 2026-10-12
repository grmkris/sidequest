import { publicKey } from '../../queries.ts'
import { cn } from '../../lib/cn.ts'
import { Item, ItemGroup, ItemMedia, ItemContent, ItemActions } from '../ui/item.tsx'
import { Section, textLinkClass } from '../kit.tsx'
import * as sdk from '@sidequest/sdk'
import { Link } from '@tanstack/react-router'
import { erc20Abi, zeroAddress } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { stakeContext } from '../../stake-context.ts'
import { formatNumber, tokenInfo } from '../../format.ts'
import { sidequest } from '../../sidequest.ts'
import { useToken } from '../../useTokens.ts'
import { chain, isMainnet } from '../../wallet.ts'

import { SideChip } from '../side/SideToken.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Mark } from '../controls.tsx'

type Hex = `0x${string}`

/**
 * "Ready to publish", read live from the wallet: MON for gas, the reward (a hire escrows it at publish), and the
 * creator bond, a reservation of stake: the check is the stake still free in the vault, with the way to stake more.
 * A quote request locks nothing yet, so its bond is what picking a quote will need. Advisory: a shortfall is shown,
 * not enforced, since the transaction says the same if it happens.
 */
export function Preflight({
  address,
  token,
  reward,
  bond,
  later = false,
}: {
  address: Hex | undefined
  token?: string | undefined
  reward?: bigint | null | undefined
  bond: bigint | null
  later?: boolean
}) {
  const on = address !== undefined
  const metadata = useToken(token)
  const who = address ?? zeroAddress
  const q = { refetchInterval: 15_000 }
  const mon = useBalance({ address: who, chainId: chain.id, query: { ...q, enabled: on } })
  const free = useReadContract({
    address: sidequest.vault,
    abi: sdk.stakeVaultAbi,
    functionName: 'availableOf',
    args: [who],
    chainId: chain.id,
    query: { ...q, enabled: on },
  })
  const held = useReadContract({
    address: (token ?? zeroAddress) as Hex,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
    chainId: chain.id,
    query: { ...q, enabled: on && token !== undefined && token !== '' },
  })
  const funding = useQuery({
    queryKey: publicKey(
      'posting-preflight',
      who.toLowerCase(),
      token?.toLowerCase(),
      reward?.toString(),
      bond?.toString(),
    ),
    enabled: on,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const ctx = stakeContext()
      const policy = await sdk.readBondPolicy(ctx)
      await sdk.requireFundingAdmission(ctx, who)
      const [pool, liquid] = await Promise.all([
        ctx.publicClient.readContract({
          address: sidequest.vault,
          abi: sdk.stakeVaultAbi,
          functionName: 'poolOf',
          args: [who],
        }),
        ctx.publicClient.readContract({
          address: ctx.deployment.sidequest!.factory,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [who],
        }),
      ])
      const need = bond !== null && bond > policy.minimumCreatorBond ? bond : policy.minimumCreatorBond
      const deposit = sdk.backingDeposit(pool, need)
      const required =
        deposit + (token?.toLowerCase() === ctx.deployment.sidequest!.factory.toLowerCase() ? (reward ?? 0n) : 0n)
      return { policy, deposit, liquid, shortfall: required > liquid ? required - liquid : 0n, need }
    },
  })

  const note = isMainnet
    ? 'Read live from your wallet. Posting holds SIDE staked behind you as the creator bond, released when the job closes.'
    : 'Read live from your wallet. Testnet MON comes from faucet.monad.xyz; SIDE, mUSD and mEUR from Get test tokens on your Account page.'
  if (!on) {
    return (
      <Section
        title="Ready to publish"
        note={
          token === undefined
            ? 'Sign in, and this checks your wallet has the gas and the deposit at risk.'
            : 'Sign in, and this checks your wallet has the gas, the reward and the deposit at risk.'
        }
      >
        <ItemGroup>
          <Item>
            <ItemMedia>
              <Mark tone="none" />
            </ItemMedia>
            <ItemContent className="flex-1 text-muted-foreground">Sign in to check your balances</ItemContent>
          </Item>
        </ItemGroup>
      </Section>
    )
  }

  const monValue = mon.data?.value
  const tokenHeld = held.data as bigint | undefined
  const sym = tokenInfo(token).symbol
  const prefix = later ? 'When you pick a quote · ' : ''

  return (
    <Section title="Ready to publish" note={note}>
      <ItemGroup>
        <Item className="before:left-14">
          <ItemMedia>
            <Mark tone={monValue === undefined ? 'wait' : monValue > 0n ? 'ok' : 'warn'} />
          </ItemMedia>
          <ItemContent className="min-w-0 flex-1">
            <span className="block">Gas</span>
            {monValue === 0n && (
              <span className="block text-ui text-warning-text">
                Add {chain.nativeCurrency.symbol} to pay for the transactions.
              </span>
            )}
          </ItemContent>
          <ItemContent className="tabular-nums text-muted-foreground">
            {monValue === undefined ? '…' : `${formatNumber(monValue, 18)} ${chain.nativeCurrency.symbol}`}
          </ItemContent>
        </Item>
        {token !== undefined && reward !== undefined && (
          <Item className="before:left-14">
            <ItemMedia>
              <Mark
                tone={
                  reward === null || tokenHeld === undefined
                    ? reward === null
                      ? 'none'
                      : 'wait'
                    : tokenHeld >= reward
                      ? 'ok'
                      : 'warn'
                }
              />
            </ItemMedia>
            <ItemContent className="min-w-0 flex-1">
              <span className="block">
                Reward · {reward === null ? `— ${sym}` : <TokenAmount value={reward} token={token} />}
              </span>
              {reward !== null && tokenHeld !== undefined && tokenHeld < reward && (
                <span className="block text-ui text-warning-text">
                  You need <TokenAmount value={reward - tokenHeld} token={token} /> more.
                </span>
              )}
            </ItemContent>
            <ItemActions className="tabular-nums flex-col items-end text-right text-muted-foreground">
              {tokenHeld === undefined || typeof metadata === 'string'
                ? 'Token amount unavailable'
                : `You hold ${formatNumber(tokenHeld, metadata.decimals)} ${metadata.symbol}`}
            </ItemActions>
          </Item>
        )}
        <Item className="before:left-14">
          <ItemMedia>
            <Mark
              tone={
                funding.isError
                  ? 'bad'
                  : funding.data === undefined
                    ? 'wait'
                    : funding.data.shortfall === 0n
                      ? 'ok'
                      : 'warn'
              }
            />
          </ItemMedia>
          <ItemContent className="min-w-0 flex-1">
            <span className="block">{prefix}SIDE backing needed</span>
            {funding.data !== undefined && funding.data.shortfall > 0n && (
              <span className="block text-ui text-warning-text">
                You need {formatNumber(funding.data.shortfall, 18)} more liquid SIDE for backing and any SIDE reward.
                Review can include a backing deposit.{' '}
                <SideChip variant="link" need={funding.data.shortfall}>
                  Get {formatNumber(funding.data.shortfall, 18)} SIDE
                </SideChip>
              </span>
            )}
            {funding.isError && (
              <span className="block text-ui text-warning-text">
                Bond policy or funding could not be read. Refresh before publishing.
              </span>
            )}
          </ItemContent>
          <ItemActions className="tabular-nums text-muted-foreground">
            {funding.data === undefined ? '…' : `${formatNumber(funding.data.liquid, 18)} liquid SIDE`}
          </ItemActions>
        </Item>
        {bond !== null && funding.data !== undefined && bond < funding.data.policy.minimumCreatorBond && (
          <p className="text-sm text-warning-text">
            The creator bond must be at least {formatNumber(funding.data?.policy.minimumCreatorBond ?? 0n, 18)} SIDE.
            Create a new offer before publishing.
          </p>
        )}
        {funding.data !== undefined && (
          <p className="text-sm text-muted-foreground">
            If nobody activates this job, {funding.data.policy.unfilledForfeitBps / 100}% (
            {formatNumber((funding.data.need * BigInt(funding.data.policy.unfilledForfeitBps)) / 10_000n, 18)} SIDE)
            goes to the treasury. Free cancel within {funding.data.policy.cancelGrace / 60} minutes.
          </p>
        )}
        <StakeRow prefix={prefix} need={funding.data?.need ?? bond ?? 0n} free={free.data} unavailable={free.isError} />
      </ItemGroup>
    </Section>
  )
}

/** The bond is reserved from stake, so what counts is the stake still free (not reserved, not unstaking). */
function StakeRow({
  prefix,
  need,
  free,
  unavailable,
}: {
  prefix: string
  need: bigint
  free: bigint | undefined
  unavailable: boolean
}) {
  return (
    <Item className="before:left-14">
      <ItemMedia>
        <Mark tone={free === undefined ? (unavailable ? 'bad' : 'wait') : free >= need ? 'ok' : 'warn'} />
      </ItemMedia>
      <ItemContent className="min-w-0 flex-1">
        <span className="block">
          {prefix}
          {need > 0n
            ? `Your deposit at risk · ${formatNumber(need, 18)} SIDE from backing`
            : 'No deposit at risk from you'}
        </span>
        {free !== undefined && free < need && (
          <span className="block text-ui text-warning-text">
            Back with {formatNumber(need - free, 18)} more SIDE.{' '}
            <Link to="/account" className={cn(textLinkClass, 'font-semibold')}>
              Manage your backing
            </Link>
          </span>
        )}
        {unavailable && (
          <span className="block text-ui text-warning-text">Available backing cannot be read right now.</span>
        )}
      </ItemContent>
      <ItemActions className="tabular-nums flex-col items-end text-right text-muted-foreground">
        {free === undefined ? '…' : `${formatNumber(free, 18)} free`}
      </ItemActions>
    </Item>
  )
}
