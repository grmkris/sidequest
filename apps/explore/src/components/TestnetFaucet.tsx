import { refreshBalances } from '../query-refresh.ts'
import { useQueryClient } from '@tanstack/react-query'
import * as sdk from '@sidequest/sdk'
import { useState } from 'react'
import { useReadContracts } from 'wagmi'
import { faucetClaim } from '../faucet-claim.ts'
import { formatNumber, relative } from '../format.ts'
import { chain, deployment, isMainnet } from '../wallet.ts'
import { useToast } from './Sheet.tsx'
import { TxSteps } from './TxSteps.tsx'
import type { WalletStep } from './txOperation.ts'
import { Button } from './ui/button.tsx'

/** Testnet-only single-call user operation. Circle supplies USDC for later self-paid actions. */
export function TestnetFaucet({ address }: { address: `0x${string}` }) {
  const faucet = deployment.testnetFaucet
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<{ id: string; txs: WalletStep[] } | null>(null)
  const reads = useReadContracts({
    contracts: (['nextDripAt', 'stakeAmount', 'paymentAmount', 'lastDrip'] as const).map(
      (functionName) =>
        ({
          address: faucet ?? deployment.factory,
          abi: sdk.testnetFaucetAbi,
          functionName,
          ...(functionName === 'nextDripAt' || functionName === 'lastDrip' ? { args: [address] } : {}),
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: faucet !== null, refetchInterval: 30_000 },
  })
  if (isMainnet || faucet === null) return null
  const [next, stake, payment, last] = (reads.data ?? []).map((r) => r.result as bigint | undefined)
  const waiting = next !== undefined && next > 0n
  const done = () => {
    setSteps(null)
    void refreshBalances(qc)
  }
  const claim = () => {
    if (last === undefined) return toast('The faucet status is still loading. Try again in a moment.')
    setSteps(faucetClaim(deployment, address, last))
  }
  const amounts =
    stake === undefined || payment === undefined
      ? 'SIDE and each test payment token'
      : `${formatNumber(stake, 18)} SIDE and ${formatNumber(payment, 6)} of each test payment token`
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={claim} busy={busy} disabled={waiting || steps !== null || last === undefined}>
          Get test tokens
        </Button>
        <span className="text-sm text-muted-foreground">
          {waiting ? `Next claim ${relative(Number(next))}` : `${amounts}, once a day. Test tokens have no value.`}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Gas is covered for this testnet claim. For later actions, get USDC from{' '}
        <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="underline">
          Circle’s faucet
        </a>{' '}
        (Monad Testnet, 20 USDC every 2 hours), or add MON.
      </p>
      {steps !== null && (
        <TxSteps
          taskId={steps.id}
          txs={steps.txs}
          owner={address}
          reportToBoard={false}
          allowSponsorship={false}
          sponsor="faucet"
          autoStart
          onBusyChange={setBusy}
          onDone={() => {
            toast('Test tokens claimed')
            done()
          }}
        />
      )}
    </div>
  )
}
