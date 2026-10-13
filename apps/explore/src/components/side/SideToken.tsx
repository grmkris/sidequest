/**
 * The SIDE control: one chip with SIDE's address that copies it and opens the SIDE sheet, where people buy or sell
 * SIDE through nad.fun's router, see what the posting bond costs, and find SIDE on nad.fun and the explorers. One
 * provider in the root layout holds the sheet, so any page opens it (`useSideSheet`), and a `?side` or `?side=<SIDE>`
 * link opens it on load. Utility only: amounts in MON with a dollar estimate beside them on mainnet (14 Oct, Kris),
 * never a chart.
 */
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { erc20Abi } from 'viem'
import { useReadContract } from 'wagmi'
import { useBondPolicy } from '../../bond-policy.ts'
import { formatAmount } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { markWelcomeShown } from '../../onboarding.ts'
import { useReplaceSearch } from '../../page-search.ts'
import { publicKey } from '../../queries.ts'
import { sideRequest, wholeUp, withoutSide } from '../../side-sheet.ts'
import { stakeContext } from '../../stake-context.ts'
import { chain, deployed, deployment, explorer, getSideLink, isMainnet, sidePages, sideToken } from '../../wallet.ts'
import { TradeCard } from './TradeCard.tsx'
import { CopyButton, shortAddress, textLinkClass } from '../kit.tsx'
import { approxUsd, useMonPrice, usdValue } from '../../usd.ts'
import { usePrivyModalOpen } from '../Privy.tsx'
import { Sheet } from '../Sheet.tsx'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { Button } from '../ui/button.tsx'
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
              onClose={() => setState((current) => ({ ...current, open: false }))}
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
  onClose,
}: {
  side: `0x${string}`
  need: bigint | null
  onBusyChange: (busy: boolean) => void
  onSignIn: () => void
  onClose: () => void
}) {
  // The trade leads; what SIDE is for (the bond) and what the wallet holds follow it in one sentence.
  return (
    <>
      {deployed && need !== null && <NeedLine need={need} />}
      <TradeCard need={need} onBusyChange={onBusyChange} onSignIn={onSignIn} onClose={onClose} />
      {deployed && <BondLine side={side} />}
      <Elsewhere side={side} />
    </>
  )
}

/** MON as the sheet writes it beside an amount: "82.36 MON", with "≈ $2.02" where MON has a price (mainnet). */
function monText(mon: bigint, price: number | undefined): string {
  const usd = usdValue(mon, 18, price)
  return `${formatAmount(mon, 18)} ${chain.nativeCurrency.symbol}${usd === undefined ? '' : `, ${approxUsd(usd)}`}`
}

/** What the router charges for `amount` SIDE now, refreshed with the curve; undefined while unread. */
function useSideCost(amount: bigint | null | undefined) {
  const ctx = stakeContext()
  const launcher = deployment.launcher
  return useQuery({
    queryKey: publicKey('side-cost', launcher?.router, amount?.toString()),
    queryFn: () => sdk.launcherSideCost(ctx, launcher!, amount!),
    enabled: launcher !== null && amount !== null && amount !== undefined,
    refetchInterval: 30_000,
    retry: false,
  }).data
}

/** The SIDE a page asked for and the wallet lacks, with its cost: the buy below is filled in with it. */
function NeedLine({ need }: { need: bigint }) {
  const cost = useSideCost(need)
  const price = useMonPrice()
  return (
    <p className="-mt-1 text-pretty text-warning-text tabular-nums">
      You need {formatAmount(wholeUp(need), 18)} more SIDE{cost !== undefined && `, about ${monText(cost, price)}`}. The
      buy below is filled in.
    </p>
  )
}

/** One sentence under the trade: the SIDE the wallet holds, and what one posting bond is and costs now. */
function BondLine({ side }: { side: `0x${string}` }) {
  const { address } = useAuth()
  const bond = useBondPolicy().data?.minimumCreatorBond
  const cost = useSideCost(bond)
  const price = useMonPrice()
  const held = useReadContract({
    address: side,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chain.id,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  }).data
  if (bond === undefined) return null
  return (
    <p className="text-ui text-pretty text-muted-foreground tabular-nums">
      {held !== undefined && `You hold ${formatAmount(held, 18)} SIDE. `}
      Posting a job bonds {formatAmount(bond, 18)} SIDE{cost !== undefined && ` (about ${monText(cost, price)})`}.
    </p>
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
  const link = cn(
    'inline-flex min-h-8 items-center gap-1 text-ui font-medium text-muted-foreground transition-colors duration-(--dur-fast) pointer-coarse:min-h-11 [@media(hover:hover)]:hover:text-foreground',
  )
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
      <ul className="flex flex-wrap gap-x-4 gap-y-0.5" aria-label="SIDE elsewhere">
        {links.map((l) => (
          <li key={l.name}>
            <a href={l.href} target="_blank" rel="noreferrer" className={link}>
              {l.name}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          </li>
        ))}
        <li>
          <a href="/docs/token" className={link}>
            About SIDE
          </a>
        </li>
        <li className="inline-flex items-center gap-0.5 font-mono text-ui text-muted-foreground">
          {shortAddress(side)}
          <CopyButton value={side} label="Copy SIDE contract address" className="size-8 pointer-coarse:size-11" />
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
        'inline-flex items-center rounded-full bg-background text-xs text-muted-foreground shadow-chip',
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
