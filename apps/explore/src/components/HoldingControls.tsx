import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Item, ItemGroup, ItemContent } from './ui/item.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Address as AddressText, Section } from './kit.tsx'
/** Holding vetoes belong to the account itself, never to an external delegator. */
import * as sdk from '@sidequest/sdk'
import { type Address, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { type SidequestContracts } from '../sidequest.ts'
import { proposalState } from '../stake.ts'
import { chain } from '../wallet.ts'
import { Countdown, When, useNow } from './Time.tsx'

export function HoldingControls({
  contracts,
  account,
  disabled,
  onVeto,
}: {
  contracts: SidequestContracts
  account: Address
  disabled: boolean
  onVeto: (holding: Address, denied: boolean) => void
}) {
  const now = useNow()
  const reads = useReadContracts({
    contracts: [
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: 'pendingHolding',
        chainId: chain.id,
      },
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: 'holdingDenied',
        args: [account, contracts.holding],
        chainId: chain.id,
      },
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: 'PROPOSAL_GRACE',
        chainId: chain.id,
      },
    ],
    query: { refetchInterval: 15_000 },
  })
  const pending = reads.data?.[0]?.status === 'success' ? reads.data[0].result : undefined
  const denied = reads.data?.[1]?.status === 'success' ? reads.data[1].result : undefined
  const grace = reads.data?.[2]?.status === 'success' ? Number(reads.data[2].result) : undefined
  const holding = pending?.[0] ?? zeroAddress
  const proposal = holding.toLowerCase() !== zeroAddress
  const veto = useReadContracts({
    contracts: [
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: 'holdingDenied',
        args: [account, holding],
        chainId: chain.id,
      },
    ],
    query: { enabled: proposal, refetchInterval: 15_000 },
  })
  const refused = veto.data?.[0]?.status === 'success' ? veto.data[0].result : undefined
  const state = proposalState(Number(pending?.[1] ?? 0), now, grace ?? Number.POSITIVE_INFINITY)
  return (
    <>
      {proposal && (
        <Section
          title="A new Holding is proposed"
          note="This veto controls your own wallet's backing. An external backer cannot change an agent's Holding permissions."
        >
          <ItemGroup className="grid gap-3 p-4">
            <Item>
              <ItemContent className="flex-1">Holding</ItemContent>
              <AddressText value={holding} />
            </Item>
            <p className="text-sm text-muted-foreground">
              {state === 'waiting' ? (
                <>
                  Can go live in <Countdown to={Number(pending![1])} />
                </>
              ) : state === 'open' ? (
                'Can go live now, once accepted'
              ) : (
                'Proposal expired'
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              Expires{' '}
              {grace === undefined ? 'at an unreadable time' : <When at={Number(pending![1]) + grace} show="time" />}
            </p>
            {refused === true ? (
              <Badge variant="destructive">Refused</Badge>
            ) : (
              <p className="text-sm text-muted-foreground">
                A Holding you refuse can never reserve this account’s backing.
              </p>
            )}
            {state !== 'expired' && (
              <Button
                variant="secondary"
                disabled={disabled || reads.isError || veto.isError || refused === undefined}
                onClick={() => onVeto(holding, !refused)}
              >
                {refused ? 'Allow it again' : 'Refuse this Holding'}
              </Button>
            )}
          </ItemGroup>
        </Section>
      )}

      {denied === true && (
        <Section title="You refused the Holding in use">
          <ItemGroup className="grid gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              It cannot reserve this wallet's backing for new job deposits at risk.
            </p>
            <Button
              variant="secondary"
              disabled={disabled || reads.isError}
              onClick={() => onVeto(contracts.holding, false)}
            >
              Allow it again
            </Button>
          </ItemGroup>
        </Section>
      )}

      {reads.isError && (
        <Alert variant="destructive">
          <AlertDescription>Holding permissions could not be read. Veto actions are unavailable.</AlertDescription>
        </Alert>
      )}
    </>
  )
}
