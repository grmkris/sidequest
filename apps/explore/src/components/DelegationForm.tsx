import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Address as AddressText, Section, Segmented } from './kit.tsx'
import type { Address } from 'viem'
import { duration } from '../duration.ts'
import { factoryAmount } from '../stake.ts'
import { formatNumber } from '../format.ts'
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
  const lacking = mode === 'add' && value !== null && wallet !== undefined && value > wallet ? value - wallet : null
  const own = account.toLowerCase() === owner.toLowerCase()
  const form = (
    <form
      className="grid gap-3 rounded-xl bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {own ? (
        <p className="text-sm text-muted-foreground">
          Your own wallet: the jobs you post reserve their deposit from this backing. Only you can leave and withdraw
          it.
        </p>
      ) : (
        <div className="grid gap-1 text-sm text-muted-foreground">
          <span>
            Backing wallet <AddressText value={account} />
          </span>
          <span>
            Your position belongs to <AddressText value={owner} />. Only you can leave and withdraw it.
          </span>
        </div>
      )}
      <Segmented
        label="Add or leave"
        value={mode}
        onChange={onMode}
        options={[
          ['add', 'Add backing'],
          ['leave', 'Leave'],
        ]}
      />
      <label className="grid gap-1.5 text-sm">
        <span>Amount of SIDE</span>
        <span className="flex gap-2">
          <Input
            id="stake-amount"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            placeholder="0"
            onChange={(event) => onText(event.target.value)}
            className="min-w-0 flex-1 tabular-nums"
          />
          <Button
            variant="secondary"
            disabled={disabled || maximum === undefined}
            onClick={() => maximum !== undefined && onText(exactFactory(maximum))}
          >
            Max
          </Button>
        </span>
      </label>
      <p className="text-sm text-muted-foreground">
        {mode === 'add'
          ? 'Review the exact amount, then confirm the backing in your wallet. Your wallet pays the gas in MON.'
          : `Leaving starts ${cooldown === undefined ? 'the vault cooldown' : `a ${duration(cooldown)} cooldown`} for all your queued shares, including any already leaving. Deposits at risk do not prevent requesting to leave; they may delay withdrawal.`}
      </p>
      {mode === 'add' && reserved !== undefined && (
        <p className="text-sm text-muted-foreground">
          Currently bonded behind this account:{' '}
          <span className="font-medium text-foreground">{factoryValue(reserved)}</span>. New backing shares open-bond
          exposure pro-rata until those jobs settle.
        </p>
      )}
      {invalid && (
        <Alert variant="destructive">
          <AlertDescription>Enter a positive SIDE amount with up to 18 decimal places.</AlertDescription>
        </Alert>
      )}
      {tooMuch && (
        <Alert variant="destructive">
          <AlertDescription>
            {mode === 'add' ? (
              <>
                That is more SIDE than your wallet holds.
                {lacking !== null && (
                  <>
                    {' '}
                    <SideChip variant="link" need={lacking} onOpen={onGetSide}>
                      Get {formatNumber(lacking, 18)} SIDE
                    </SideChip>
                  </>
                )}
              </>
            ) : (
              'That is more than your active position.'
            )}
          </AlertDescription>
        </Alert>
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
