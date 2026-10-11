import { formatEther, parseEther } from 'viem'
import { deployment } from '../wallet.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { textLinkClass } from './kit.tsx'

/** About one backing send at testnet gas prices, with room to spare: backing is not gas-sponsored. */
export const BACKING_GAS = parseEther('0.03')
/**
 * One Buy SIDE swap at testnet gas prices (102 gwei): the SDK sends two approvals of 80k gas and a 700k-gas swap, and
 * Monad bills the whole limit, so about 0.088 MON. More than the faucet's one-time 0.05 MON.
 */
export const SWAP_GAS = parseEther('0.09')

const mon = (value: bigint) => Number(formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: 4 })

/**
 * What the wallet sends itself (backing, a swap) needs MON for gas, which Sidequest does not sponsor. Said before the
 * form, not after a failed send.
 */
export function GasWarning({
  mon: held,
  action = 'Backing',
  need = BACKING_GAS,
}: {
  mon: bigint | undefined
  action?: string
  need?: bigint
}) {
  if (held === undefined || held >= need) return null
  return (
    <Alert>
      <AlertDescription>
        {action} is sent from your wallet, which pays the gas in MON; Sidequest does not sponsor it. Your wallet holds{' '}
        {mon(held)} MON and needs about {mon(need)}.{' '}
        {deployment.testnetFaucet !== null ? (
          <>
            Get testnet MON at{' '}
            <a className={textLinkClass} href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
              faucet.monad.xyz
            </a>
            .
          </>
        ) : (
          'Add MON to your wallet first.'
        )}
      </AlertDescription>
    </Alert>
  )
}
