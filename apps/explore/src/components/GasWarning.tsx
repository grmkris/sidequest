import { formatEther, parseEther } from 'viem'
import { deployment } from '../wallet.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { textLinkClass } from './kit.tsx'

/** About one backing send at testnet gas prices, with room to spare: the MON fallback. */
const BACKING_GAS = parseEther('0.03')
/**
 * One Buy SIDE swap at testnet gas prices (102 gwei): the SDK sends two approvals of 80k gas and a 700k-gas swap, and
 * Monad bills the whole limit, so about 0.088 MON. More than the faucet's one-time 0.05 MON.
 */
export const SWAP_GAS = parseEther('0.09')

const mon = (value: bigint) => Number(formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: 4 })

/**
 * Funding for the wallet’s USDC gas path or MON fallback. Said before the
 * form, not after a failed send.
 */
export function GasWarning({
  mon: held,
  action = 'Backing',
  need = BACKING_GAS,
  usdc,
  allowUsdc = true,
}: {
  mon: bigint | undefined
  action?: string
  need?: bigint
  usdc?: bigint | undefined
  allowUsdc?: boolean
}) {
  const aa = deployment.aa
  const usdcReady = allowUsdc && aa !== null && aa.paymaster !== null && usdc !== undefined && usdc >= aa.maxCostPerOp
  if (usdcReady || held === undefined || held >= need) return null
  return (
    <Alert>
      <AlertDescription>
        {action} is sent from your wallet, which pays the gas. For the MON path, your wallet holds {mon(held)} MON and
        needs about {mon(need)}. {allowUsdc && <>You can use USDC for gas instead. </>}
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
