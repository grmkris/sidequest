// Vrials' treasury holds USDG on Robinhood Chain (no Circle USDC, no CCTP there). Work settles in USDC on
// Monad. The bridge stands in for an intent bridge (Across/Relay style): a deposit is its own refundable
// object, so a stuck transfer never touches a live job.
import type { Address } from 'viem'
import type { Monad } from './chain'

export class Robinhood {
  readonly usdg = new Map<Address, bigint>()

  balance(account: Address) {
    return this.usdg.get(account) ?? 0n
  }

  mint(account: Address, amount: bigint) {
    this.usdg.set(account, this.balance(account) + amount)
  }

  burn(account: Address, amount: bigint) {
    if (this.balance(account) < amount) throw new Error('insufficient USDG')
    this.usdg.set(account, this.balance(account) - amount)
  }
}

export interface Deposit {
  id: number
  from: Address
  to: Address
  amount: bigint
  status: 'pending' | 'filled' | 'refunded'
  received?: bigint
}

export class Bridge {
  private readonly deposits: Deposit[] = []

  constructor(
    private readonly rh: Robinhood,
    private readonly monad: Monad,
    private readonly feeBps = 5n,
  ) {}

  send(from: Address, to: Address, amount: bigint) {
    this.rh.burn(from, amount)
    const deposit: Deposit = { id: this.deposits.length, from, to, amount, status: 'pending' }
    this.deposits.push(deposit)
    return deposit
  }

  // A solver fronts USDC on Monad and later claims the USDG on Robinhood.
  fill(id: number) {
    const d = this.pending(id)
    d.received = d.amount - (d.amount * this.feeBps) / 10_000n
    this.monad.mint(d.to, d.received)
    d.status = 'filled'
    return d
  }

  refund(id: number) {
    const d = this.pending(id)
    this.rh.mint(d.from, d.amount)
    d.status = 'refunded'
    return d
  }

  private pending(id: number) {
    const d = this.deposits[id]
    if (!d || d.status !== 'pending') throw new Error('no pending deposit')
    return d
  }
}
