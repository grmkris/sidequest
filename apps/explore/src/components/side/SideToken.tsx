/**
 * The SIDE control: one chip with SIDE's address that copies it and opens the SIDE sheet, where people see what the
 * posting bond costs in MON, buy or sell SIDE through nad.fun's router, and find SIDE on nad.fun and the explorers. One
 * provider in the root layout holds the sheet, so any page opens it (`useSideSheet`), and a `?side` or `?side=<SIDE>`
 * link opens it on load. Utility only: what SIDE is for and what it costs in MON, never a dollar price or a chart.
 */
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { erc20Abi } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { useBondPolicy } from '../../bond-policy.ts'
import { formatNumber } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { markWelcomeShown } from '../../onboarding.ts'
import { useReplaceSearch } from '../../page-search.ts'
import { publicKey } from '../../queries.ts'
import { fillMon, sideRequest, sideTrade, withoutSide } from '../../side-sheet.ts'
import { stakeContext } from '../../stake-context.ts'
import {
  chain,
  deployed,
  deployment,
  explorer,
  getSideLink,
  isMainnet,
  sidePages,
  sideToken,
  writesOpen,
} from '../../wallet.ts'
import { LauncherPanel, type Trade } from '../Buy.tsx'
import { SWAP_GAS } from '../GasWarning.tsx'
import { CopyButton, Segmented, shortAddress, textLinkClass } from '../kit.tsx'
import { PrivyLogin, usePrivyAuthenticated, usePrivyModalOpen } from '../Privy.tsx'
import { Sheet } from '../Sheet.tsx'
import { TestnetFaucet } from '../TestnetFaucet.tsx'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { Button, buttonVariants } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'

interface SideOpen {
  /** SIDE still to buy, net of what the wallet holds: the sheet says so and can fill the buy with its cost. */
  need?: bigint | null | undefined
  /** Where focus goes once the sheet has closed, when the control that opened it is gone (a closed popover's item). */
  returnFocus?: HTMLElement | null | undefined
}

interface SideSheetApi {
  open: (request?: SideOpen) => void
  /** The sheet is on screen: the first-run redirect to Welcome waits for it (`onboarding.ts`). */
  showing: boolean
}

const SideContext = createContext<SideSheetApi | null>(null)

/** The SIDE sheet's opener; null outside `SideTokenProvider` (the embedded widget, unit tests), where SIDE controls render nothing. */
export function useSideSheet(): SideSheetApi | null {
  return useContext(SideContext)
}

/** How long the sheet's exit plays before its body unmounts, so a closed sheet polls nothing. */
const EXIT_MS = 450

/** Holds the SIDE sheet for every page under it: mount it once, in the root layout. */
export function SideTokenProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => (sideToken === null ? null : sideRequest(window.location.search)))
  const [state, setState] = useState({ open: initial !== null, need: initial?.need ?? null, key: 0 })
  const [mounted, setMounted] = useState(state.open)
  const [busy, setBusy] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const privyModal = usePrivyModalOpen()
  const replaceSearch = useReplaceSearch()
  // The sheet holds the amount now; drop `?side` from the URL so a reload does not open it again.
  useEffect(() => {
    if (initial !== null) replaceSearch(withoutSide(window.location.search))
  }, [])

  useEffect(() => {
    if (state.open) {
      setMounted(true)
      return
    }
    const t = setTimeout(() => {
      setMounted(false)
      const target = returnFocus.current
      returnFocus.current = null
      if (target?.isConnected === true) target.focus()
    }, EXIT_MS)
    return () => clearTimeout(t)
  }, [state.open])

  // Another page closes the sheet, unless a wallet request is pending in it.
  const { pathname } = useLocation()
  const page = useRef(pathname)
  useEffect(() => {
    if (page.current === pathname) return
    page.current = pathname
    if (!busy) setState((s) => (s.open ? { ...s, open: false } : s))
  }, [pathname, busy])

  // A sign-in started in the sheet stays in it: Welcome counts as shown for this tab, so the first app page after it
  // does not redirect there (the "Finish setup" pill still leads to it).
  const signInHere = useRef(false)
  const { address } = useAuth()
  useEffect(() => {
    if (address === undefined || !signInHere.current) return
    signInHere.current = false
    markWelcomeShown(address)
  }, [address])

  const open = useCallback((request: SideOpen = {}) => {
    returnFocus.current = request.returnFocus ?? null
    setState((s) => ({ open: true, need: request.need ?? null, key: s.key + 1 }))
  }, [])
  const api = useMemo(() => ({ open, showing: state.open }), [open, state.open])
  return (
    <SideContext value={api}>
      {children}
      {sideToken !== null && (
        <Sheet
          open={state.open}
          onClose={() => setState((s) => ({ ...s, open: false }))}
          title={
            <span className="inline-flex items-center gap-2">
              <TokenIcon token={sideToken} />
              SIDE
            </span>
          }
          // Privy draws its login and wallet prompts in the page, under a modal dialog: the sheet steps out of the
          // top layer while one shows, so the prompt can be used without closing the sheet.
          walletPrompt={state.open && (busy || privyModal)}
        >
          {mounted && (
            <SideSheetBody
              key={state.key}
              side={sideToken}
              need={state.need}
              onBusyChange={setBusy}
              onSignIn={() => {
                signInHere.current = true
              }}
            />
          )}
        </Sheet>
      )}
    </SideContext>
  )
}

function SideSheetBody({
  side,
  need,
  onBusyChange,
  onSignIn,
}: {
  side: `0x${string}`
  need: bigint | null
  onBusyChange: (busy: boolean) => void
  onSignIn: () => void
}) {
  const [trade, setTrade] = useState<Trade>('buy')
  const [text, setText] = useState('')
  return (
    <>
      <p className="-mt-2 leading-snug text-pretty text-muted-foreground">
        The token Sidequest&apos;s bonds and backing are held in.
      </p>
      <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted/60 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 font-mono text-ui [overflow-wrap:anywhere]">{side}</code>
        <CopyButton value={side} label="Copy SIDE contract address" />
      </div>
      {deployed && (
        <BondCost
          side={side}
          need={need}
          onFill={(mon) => {
            setTrade('buy')
            setText(mon)
          }}
        />
      )}
      <TradeSection
        trade={trade}
        onTrade={(next) => {
          setTrade(next)
          setText('')
        }}
        text={text}
        onText={setText}
        onBusyChange={onBusyChange}
        onSignIn={onSignIn}
      />
      <Elsewhere side={side} />
    </>
  )
}

/** What SIDE is for, in MON: the posting bond's cost now, the wallet's SIDE, and any SIDE still needed with its cost. */
function BondCost({ side, need, onFill }: { side: `0x${string}`; need: bigint | null; onFill: (mon: string) => void }) {
  const ctx = stakeContext()
  const launcher = deployment.launcher
  const { address } = useAuth()
  const bond = useBondPolicy().data?.minimumCreatorBond
  const cost = useQuery({
    queryKey: publicKey('side-cost', launcher?.router, bond?.toString()),
    queryFn: () => sdk.launcherSideCost(ctx, launcher!, bond!),
    enabled: launcher !== null && bond !== undefined,
    refetchInterval: 30_000,
    retry: false,
  })
  const needCost = useQuery({
    queryKey: publicKey('side-cost', launcher?.router, need?.toString()),
    queryFn: () => sdk.launcherSideCost(ctx, launcher!, need!),
    enabled: launcher !== null && need !== null,
    refetchInterval: 30_000,
    retry: false,
  })
  const held = useReadContract({
    address: side,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chain.id,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  }).data
  const mon = chain.nativeCurrency.symbol
  // Fill only where the buy form shows: writes open, a launcher, a connected wallet.
  const fill =
    writesOpen && launcher !== null && address !== undefined && needCost.data !== undefined
      ? fillMon(needCost.data)
      : null
  return (
    <div className="grid gap-2">
      {bond !== undefined && (
        <p className="text-pretty">
          Posting a job holds <span className="font-medium tabular-nums">{formatNumber(bond, 18)} SIDE</span> as its
          bond
          {cost.data !== undefined ? (
            <>
              : about{' '}
              <span className="font-medium tabular-nums">
                {formatNumber(cost.data, 18)} {mon}
              </span>{' '}
              on nad.fun now.
            </>
          ) : cost.isError ? (
            <>. nad.fun can&apos;t quote SIDE right now.</>
          ) : (
            '.'
          )}
        </p>
      )}
      {held !== undefined && (
        <p className="text-muted-foreground tabular-nums">You hold {formatNumber(held, 18)} SIDE.</p>
      )}
      {need !== null && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warning/14 py-2 pr-2 pl-3 text-warning-text">
          <span className="tabular-nums">
            You need {formatNumber(need, 18)} more SIDE
            {needCost.data !== undefined && `: about ${formatNumber(needCost.data, 18)} ${mon}`}.
          </span>
          {fill !== null && (
            <Button size="sm" variant="outline" onClick={() => onFill(fill)}>
              Fill
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Buy or sell from the connected wallet, or what stands in the way: launch, sign-in, a wallet still connecting. */
function TradeSection(props: {
  trade: Trade
  onTrade: (trade: Trade) => void
  text: string
  onText: (text: string) => void
  onBusyChange: (busy: boolean) => void
  onSignIn: () => void
}) {
  const { address } = useAuth()
  const authenticated = usePrivyAuthenticated()
  const launcher = deployment.launcher
  const state = sideTrade({ writesOpen, launcher: launcher !== null, address, authenticated })
  if (state === 'closed') return <p className="text-muted-foreground">Buying and selling here opens at launch.</p>
  if (state === 'unavailable')
    return <p className="text-muted-foreground">Buying and selling here is not available on this network.</p>
  if (state === 'sign-in')
    return (
      <div className="grid justify-items-start gap-2 rounded-xl bg-muted/50 p-3">
        <p className="text-pretty">
          Sign in to buy or sell SIDE here, with {chain.nativeCurrency.symbol} from your wallet.
        </p>
        <span onClickCapture={props.onSignIn}>
          <PrivyLogin />
        </span>
      </div>
    )
  if (state === 'connecting' || address === undefined || launcher === null)
    return <output className="block text-muted-foreground">Connecting your wallet…</output>
  return <Trading {...props} launcher={launcher} address={address} />
}

/** The Buy | Sell form over nad.fun's router; a finished trade says what it returned and starts a fresh form. */
function Trading({
  launcher,
  address,
  trade,
  onTrade,
  text,
  onText,
  onBusyChange,
}: {
  launcher: sdk.Launcher
  address: `0x${string}`
  trade: Trade
  onTrade: (trade: Trade) => void
  text: string
  onText: (text: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ trade: Trade; out: bigint } | null>(null)
  const [round, setRound] = useState(0)
  const busyChange = useCallback(
    (next: boolean) => {
      setBusy(next)
      onBusyChange(next)
    },
    [onBusyChange],
  )
  return (
    <div className="grid gap-3">
      <Segmented
        label="Buy or sell SIDE"
        value={trade}
        options={[
          ['buy', 'Buy'],
          ['sell', 'Sell'],
        ]}
        onChange={(next) => {
          if (busy || next === trade) return
          setDone(null)
          onTrade(next)
        }}
        className={cn('w-full', busy && 'pointer-events-none opacity-60')}
      />
      {done !== null && (
        <output className="block text-success-text tabular-nums">
          {done.trade === 'buy'
            ? `Bought about ${formatNumber(done.out, 18)} SIDE.`
            : `Sold for about ${formatNumber(done.out, 18)} ${chain.nativeCurrency.symbol}.`}
        </output>
      )}
      <LauncherPanel
        key={`${trade}:${round}`}
        launcher={launcher}
        trade={trade}
        address={address}
        text={text}
        onText={onText}
        onBusyChange={busyChange}
        onDone={(result) => {
          setDone(result)
          onText('')
          setRound((r) => r + 1)
        }}
      />
      <NoGas address={address} />
      <TestnetFaucet address={address} />
    </div>
  )
}

/** A wallet without MON for gas cannot trade: where to send it. */
function NoGas({ address }: { address: `0x${string}` }) {
  const gas = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } }).data?.value
  if (gas === undefined || gas >= SWAP_GAS) return null
  return (
    <div className="grid gap-1.5">
      <p className="text-muted-foreground">
        Send {chain.nativeCurrency.symbol} to your wallet from any wallet you have:
      </p>
      <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted/60 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 font-mono text-ui [overflow-wrap:anywhere]">{address}</code>
        <CopyButton value={address} label="Copy your address" />
      </div>
    </div>
  )
}

/** SIDE elsewhere: its launcher, the explorers, a tracker once it trades on a DEX pair, and the docs. */
function Elsewhere({ side }: { side: `0x${string}` }) {
  const ctx = stakeContext()
  const launcher = deployment.launcher
  const graduated = useQuery({
    queryKey: publicKey('side-graduated', launcher?.router),
    queryFn: () => sdk.launcherGraduated(ctx, launcher!),
    enabled: deployed && launcher !== null,
    staleTime: 5 * 60_000,
    retry: false,
  }).data
  const links = [
    ...(getSideLink === null ? [] : [{ name: 'nad.fun', href: getSideLink }]),
    { name: chain.blockExplorers?.default.name ?? 'Explorer', href: explorer('token', side) },
    ...sidePages.filter((p) => !p.graduated || graduated === true),
  ]
  const link = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')
  return (
    <div className="grid gap-2.5 border-t pt-4">
      {graduated !== undefined && (
        <p className="text-muted-foreground">
          {graduated
            ? "SIDE trades on nad.fun's DEX pair."
            : isMainnet
              ? "SIDE trades on nad.fun's bonding curve."
              : "Testnet SIDE trades on nad.fun's testnet curve, which has no website: buy and sell it here."}
        </p>
      )}
      <ul className="flex flex-wrap gap-2" aria-label="SIDE elsewhere">
        {links.map((l) => (
          <li key={l.name}>
            <a href={l.href} target="_blank" rel="noreferrer" className={link}>
              {l.name}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </li>
        ))}
        <li>
          <a href="/docs/token" className={link}>
            About SIDE
          </a>
        </li>
      </ul>
    </div>
  )
}

/**
 * The SIDE control. `full`: SIDE, its short address and a copy button; `compact`: SIDE alone, for tight bars; `action`:
 * an outline "Get SIDE" button; `link`: the same as a quiet text link. Each opens the SIDE sheet, `need` filled in
 * where the caller knows the SIDE still to buy. Renders nothing while SIDE is unknown or outside the provider.
 */
export function SideChip({
  variant = 'full',
  need,
  onOpen,
  children,
  className,
}: {
  variant?: 'full' | 'compact' | 'action' | 'link'
  need?: bigint | null | undefined
  /** Runs first: a control inside another sheet closes it, since a second modal would leave Privy's prompts inert. */
  onOpen?: (() => void) | undefined
  children?: ReactNode
  className?: string | undefined
}) {
  const sheet = useSideSheet()
  if (sheet === null || sideToken === null) return null
  const open = () => {
    onOpen?.()
    sheet.open({ need })
  }
  if (variant === 'action')
    return (
      <Button variant="outline" className={cn('w-fit', className)} onClick={open}>
        {children ?? 'Get SIDE'}
      </Button>
    )
  if (variant === 'link')
    return (
      <button type="button" className={cn(textLinkClass, className)} onClick={open}>
        {children ?? 'Get SIDE'}
      </button>
    )
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border text-xs text-muted-foreground',
        variant === 'full' && 'pr-0.5',
        className,
      )}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        title="SIDE: its address, what the bond costs, buying and selling"
        onClick={open}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-2 outline-none transition-[color,scale] duration-(--dur-fast) focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.96] [@media(hover:hover)]:hover:text-foreground"
      >
        <TokenIcon token={sideToken} />
        <span className="font-sans font-semibold text-foreground">SIDE</span>
        {variant === 'full' && <span className="font-mono">{shortAddress(sideToken)}</span>}
      </button>
      {variant === 'full' && <CopyButton value={sideToken} label="Copy SIDE contract address" className="size-7" />}
    </span>
  )
}
