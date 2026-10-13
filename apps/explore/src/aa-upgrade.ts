import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, type TypedDataDefinition, formatEther } from 'viem'
import { BrowserUserOp } from './aa-controller.ts'
import { browserAaRpc, browserPaymentMode } from './aa-request.ts'
import { readTxJournal, txJournalKey, writeTxJournal } from './components/txJournal.ts'
import { withWalletAccountLock, withWalletStepLock, type WalletStep } from './components/txOperation.ts'

/** A bounded paymaster approval gives the first self-paid operation a useful, explicit effect. */
function upgradeSteps(deployment: sdk.Deployment): WalletStep[] {
  const aa = deployment.aa
  if (aa === null || aa.paymaster === null) throw new Error('USDC gas is not configured yet.')
  const call = sdk.approveCall(aa.gasToken, aa.paymaster, aa.standingApproval)
  return [{ description: 'Enable gas in USDC', chainId: deployment.chainId, ...call, value: '0' }]
}

/** What lets a wallet upgrade itself: USDC for the gas, or enough MON for a MON-paid operation. */
function upgradeRefusal(deployment: sdk.Deployment): string {
  const floor = deployment.aa === null ? null : sdk.nativeLaneFloor(deployment.aa)
  if (floor === null) return 'Add USDC to enable limited spending permissions from this wallet.'
  return `Add USDC, or hold at least ${formatEther(floor)} MON, to enable limited spending permissions from this wallet.`
}

/**
 * Permission flows use the same persisted AA journal as ordinary wallet actions, never a relay upgrade. A wallet with
 * MON but no USDC sends the upgrade as a MON-paid operation; its approval still readies USDC gas for later.
 */
export async function selfPaidUpgrade(input: {
  deployment: sdk.Deployment
  rpcUrl: string
  sender: Address
  authorize: () => Promise<sdk.SignedAuthorization>
  sign: (typedData: TypedDataDefinition, description: string) => Promise<Hex>
}): Promise<Hex> {
  const txs = upgradeSteps(input.deployment)
  const rpc = browserAaRpc(input.rpcUrl)
  const key = txJournalKey(`upgrade:${input.deployment.chainId}:${input.sender.toLowerCase()}`, txs)
  return withWalletStepLock(navigator.locks, key, () =>
    withWalletAccountLock(navigator.locks, input.deployment.chainId, input.sender, async () => {
      const saved = readTxJournal(localStorage, key)
      const mode =
        saved?.aa == null
          ? await browserPaymentMode(rpc, input.deployment, input.sender, txs, { canAuthorize: true })
          : null
      if (mode !== null && mode !== 'userop' && mode !== 'userop-native')
        throw new Error(upgradeRefusal(input.deployment))
      let receipt: Hex | null = null
      const controller = new BrowserUserOp({
        rpc,
        deployment: input.deployment,
        sender: input.sender,
        txs,
        payment: mode === 'userop-native' ? 'native' : 'token',
        read: async () => readTxJournal(localStorage, key),
        write: async (next) => writeTxJournal(localStorage, key, next),
        guard: async () => {},
        authorize: input.authorize,
        sign: input.sign,
        report: async () => {},
        verify: async () => {},
        changed: () => {},
        done: (hash) => {
          receipt = hash
        },
      })
      await controller.load()
      if (receipt !== null) return receipt
      await controller.prepare()
      await controller.send()
      if (receipt === null) throw new Error('The wallet setup is pending. Retry to reconcile the same operation.')
      return receipt
    }),
  )
}
