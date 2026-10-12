import { refreshBalances } from '../query-refresh.ts'
import { useQueryClient } from '@tanstack/react-query'
import * as sdk from '@sidequest/sdk'
import { useState } from 'react'
import { useReadContracts } from 'wagmi'
import { tool } from '../api.ts'
import { formatNumber, relative } from '../format.ts'
import { chain, deployment, isMainnet } from '../wallet.ts'
import { useToast } from './Sheet.tsx'
import { TxSteps } from './TxSteps.tsx'
import type { WalletStep } from './txOperation.ts'
import { Button } from './ui/button.tsx'
import { useAuth } from './Wallet.tsx'

type FaucetOutcome =
  | { status: 'sent'; txHash: string }
  | { status: 'self'; transaction: { to: `0x${string}`; data: `0x${string}`; chainId: number } }
  | { status: 'cooldown'; nextAt: number }
  | { status: 'pending' | 'unavailable'; reason: string }

/**
 * Testnet only: claim the `TestnetFaucet` once a day (SIDE plus each test payment token). The board decides who pays the
 * gas: a wallet with MON sends the claim itself, one without gets it sent by the relay along with its first MON.
 */
export function TestnetFaucet({ address }: { address: `0x${string}` }) {
  const faucet = deployment.testnetFaucet
  const auth = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<{ id: string; txs: WalletStep[] } | null>(null)
  const reads = useReadContracts({
    contracts: (['nextDripAt', 'stakeAmount', 'paymentAmount'] as const).map(
      (functionName) =>
        ({
          address: faucet ?? deployment.factory,
          abi: sdk.testnetFaucetAbi,
          functionName,
          ...(functionName === 'nextDripAt' ? { args: [address] } : {}),
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: faucet !== null, refetchInterval: 30_000 },
  })
  if (isMainnet || faucet === null) return null
  const [next, stake, payment] = (reads.data ?? []).map((r) => r.result as bigint | undefined)
  const waiting = next !== undefined && next > 0n
  const done = () => {
    setSteps(null)
    void refreshBalances(qc)
  }
  const claim = async () => {
    setBusy(true)
    try {
      if (!auth.signedIn) await auth.signIn()
      const out = await tool<FaucetOutcome>('testnet_faucet')
      if (out.status === 'self') {
        setSteps({
          id: `faucet:${address}:${Date.now()}`,
          txs: [
            {
              description: 'Claim test tokens',
              chainId: out.transaction.chainId,
              to: out.transaction.to,
              data: out.transaction.data,
              value: '0',
              gas: '300000',
            },
          ],
        })
      } else if (out.status === 'sent') {
        toast('Test tokens sent to your wallet')
        done()
      } else if (out.status === 'cooldown') toast(`Next claim ${relative(out.nextAt)}`)
      else toast(out.reason)
    } catch (e) {
      toast((e as Error).message.split('\n')[0] ?? 'The faucet is unavailable')
    } finally {
      setBusy(false)
    }
  }
  const amounts =
    stake === undefined || payment === undefined
      ? 'SIDE and each test payment token'
      : `${formatNumber(stake, 18)} SIDE and ${formatNumber(payment, 6)} of each test payment token`
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={claim} busy={busy} disabled={waiting || steps !== null}>
          Get test tokens
        </Button>
        <span className="text-sm text-muted-foreground">
          {waiting ? `Next claim ${relative(Number(next))}` : `${amounts}, once a day. Test tokens have no value.`}
        </span>
      </div>
      {steps !== null && (
        <TxSteps
          taskId={steps.id}
          txs={steps.txs}
          owner={address}
          reportToBoard={false}
          allowSponsorship={false}
          autoStart
          onDone={() => {
            toast('Test tokens claimed')
            done()
          }}
        />
      )}
    </div>
  )
}
