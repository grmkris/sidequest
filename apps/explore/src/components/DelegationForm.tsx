import { Button } from './ui/button.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Address as AddressText, Section, Segmented } from './kit.tsx'
import type { Address } from 'viem'
import { duration } from '../duration.ts'
import { factoryAmount } from '../stake.ts'
import { formatAmount } from '../format.ts'
import { cn } from '../lib/cn.ts'
import { sideToken } from '../wallet.ts'
import { AmountField } from './money/AmountField.tsx'
import { wholeUp } from '../side-sheet.ts'
import { SideChip } from './side/SideToken.tsx'

import { factoryValue } from './DelegationPositions.tsx'

export function DelegationForm({
  account,
  owner,
  mode,
  text,
  wallet,
  active,
  reserved,
  cooldown,
  disabled,
  busy,
  error,
  onMode,
  onText,
  onSubmit,
  framed = true,
  onGetSide,
}: {
  account: Address
  owner: Address
  mode: 'add' | 'leave'
  text: string
  wallet: bigint | undefined
  active: bigint | undefined
  reserved: bigint | undefined
  cooldown: number | undefined
  disabled: boolean
  busy: boolean
  error: string | null
  onMode: (mode: 'add' | 'leave') => void
  onText: (text: string) => void
  onSubmit: () => void
  /** Inside a sheet, which carries its own title, the form goes without its section. */
  framed?: boolean
  /** Closes the sheet the form sits in before the SIDE sheet opens over it. */
  onGetSide?: (() => void) | undefined
}) {
  const value = factoryAmount(text)
  const maximum = mode === 'add' ? wallet : active
  const invalid = text.trim() !== '' && value === null
  const tooMuch = value !== null && maximum !== undefined && value > maximum
  /** The SIDE the wallet lacks for this backing, which the SIDE sheet offers to buy. */
  const lacking =
    mode === 'add' && value !== null && wallet !== undefined && value > wallet ? wholeUp(value - wallet) : null
  const own = account.toLowerCase() === owner.toLowerCase()
  const hint = invalid ? (
    'Enter a positive amount with up to 18 decimal places.'
  ) : tooMuch ? (
    mode === 'add' ? (
      <>
        More than your wallet holds.
        {lacking !== null && (
          <>
            {' '}
            <SideChip variant="link" need={lacking} onOpen={onGetSide}>
              Get {formatAmount(lacking, 18)} SIDE
            </SideChip>
          </>
        )}
      </>
    ) : (
      'More than your active position.'
    )
  ) : mode === 'add' ? (
    'You review the exact amount, then confirm it in your wallet, which pays the gas.'
  ) : (
    `Leaving starts ${cooldown === undefined ? 'the vault cooldown' : `a ${duration(cooldown)} cooldown`} for all your queued shares, including any already leaving. Deposits at risk do not prevent requesting to leave; they may delay withdrawal.`
  )
  const form = (
    <form
      className={cn('grid gap-4', framed && 'rounded-xl bg-card p-4')}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <p className="text-ui text-pretty text-muted-foreground">
        {own ? (
          'Your own wallet: the jobs you post reserve their deposit from this backing.'
        ) : (
          <>
            Backing wallet <AddressText value={account} />
          </>
        )}{' '}
        Only you can leave and withdraw it.
      </p>
      <Segmented
        label="Add or leave"
        value={mode}
        onChange={onMode}
        options={[
          ['add', 'Add backing'],
          ['leave', 'Leave'],
        ]}
      />
      <AmountField
        id="stake-amount"
        label={mode === 'add' ? 'Back with' : 'Leave'}
        value={text}
        onChange={onText}
        token={sideToken}
        symbol="SIDE"
        balance={maximum === undefined ? undefined : formatAmount(maximum, 18)}
        onMax={disabled || maximum === undefined ? undefined : () => onText(exactFactory(maximum))}
        hint={hint}
        tone={invalid ? 'destructive' : tooMuch ? 'warning' : 'neutral'}
        disabled={disabled}
      />
      {mode === 'add' && reserved !== undefined && reserved > 0n && (
        <p className="text-ui text-pretty text-muted-foreground">
          Currently bonded behind this account:{' '}
          <span className="font-medium text-foreground">{factoryValue(reserved)}</span>. New backing shares open-bond
          exposure pro-rata until those jobs settle.
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button
        type="submit"
        size="lg"
        busy={busy}
        disabled={disabled || maximum === undefined || value === null || tooMuch}
      >
        {mode === 'add'
          ? `Back with ${value === null ? 'SIDE' : factoryValue(value)}`
          : value === null
            ? 'Leave'
            : `Leave ${factoryValue(value)}`}
      </Button>
    </form>
  )
  if (!framed) return form
  return (
    <Section title={mode === 'add' ? (own ? 'Back my wallet' : 'Back this agent') : 'Leave this position'}>
      {form}
    </Section>
  )
}

export function exactFactory(value: bigint): string {
  const digits = value.toString().padStart(19, '0')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  return `${digits.slice(0, -18)}${fraction === '' ? '' : `.${fraction}`}`
}
