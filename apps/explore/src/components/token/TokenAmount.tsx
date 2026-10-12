/**
 * An amount in a token, as one chip used everywhere amounts appear: the token's icon, then "4.5 mUSD" as ONE text node
 * in its own span (tests and the live harness read amounts by exact text), and on press — or hover, where there is
 * one — a popover with what the token is: name, address, whether Sidequest lists it, and a link to Monadscan.
 *
 * Inside a link or a button (a whole-row link, a "Pay 5 mUSD" button) a second interactive element would be invalid,
 * so there the chip is static: wrap such places in `<StaticTokens>`. The popover is not in the DOM until opened.
 */
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { ExternalLink } from 'lucide-react'
import { type ReactNode, type RefObject, createContext, useContext, useRef, useState } from 'react'
import { amount, tokenMeta } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { MONAD_BADGE, TOKEN_LOGOS } from '../../tokens.generated.ts'
import { useToken } from '../../useTokens.ts'
import { chain, sideToken } from '../../wallet.ts'
import { Popover, PopoverContent } from '../ui/popover.tsx'
import { useSideSheet } from '../side/SideToken.tsx'
import { TokenIcon, tokenSource } from './TokenIcon.tsx'

const Static = createContext(false)

/** Chips inside are plain text and icon, never a button: for links, buttons and anything already interactive. */
export function StaticTokens({ children }: { children: ReactNode }) {
  return <Static.Provider value>{children}</Static.Provider>
}

/** The token's page on the chain's explorer. */
const tokenExplorer = (address: string) => `${chain.blockExplorers?.default.url ?? ''}/token/${address}`

const SOURCE: Record<ReturnType<typeof tokenSource>, string> = {
  sidequest: 'Listed by Sidequest',
  'monad-list': "On Monad's token list",
  web3icons: 'Known to web3icons',
  unlisted: 'Not listed: anyone can name a token anything. Check the address.',
}

export function TokenAmount({
  value,
  token,
  className,
  static: forceStatic = false,
  text: given,
}: {
  value: string | bigint | null | undefined
  token: string | null | undefined
  className?: string | undefined
  static?: boolean | undefined
  /** Words already formatted elsewhere ("12.5 mUSD" from a quote), shown instead of formatting `value`. */
  text?: string | undefined
}) {
  // Re-render once a token read from the chain registers its symbol and decimals.
  useToken(token)
  const inert = useContext(Static) || forceStatic
  const text = given ?? amount(value === null || value === undefined ? value : String(value), token)
  if (token === null || token === undefined || token === '')
    return <span className={cn('tabular-nums whitespace-nowrap', className)}>{text}</span>
  const face = (
    <>
      <TokenIcon token={token} className="mr-[0.3em]" />
      <span>{text}</span>
    </>
  )
  if (inert) return <span className={cn('tabular-nums whitespace-nowrap', className)}>{face}</span>
  return (
    <TokenPopover token={token} className={className}>
      {face}
    </TokenPopover>
  )
}

function TokenPopover({
  token,
  className,
  children,
}: {
  token: string
  className?: string | undefined
  children: ReactNode
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  // A popup portalled to <body> renders under an open modal <dialog> (a Sheet's top layer): portal into the dialog.
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined)
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setContainer(trigger.current?.closest('dialog') ?? undefined)
      }}
    >
      <PopoverPrimitive.Trigger
        ref={trigger}
        openOnHover
        delay={350}
        className={cn(
          'tabular-nums inline cursor-pointer appearance-none rounded-sm bg-transparent p-0 text-left font-[inherit] whitespace-nowrap text-inherit',
          'decoration-current/30 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:hover)]:hover:underline',
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverContent container={container} side="bottom" align="start" className="w-64">
        {/* Get SIDE only outside sheets: a second modal over one would leave Privy's prompts inert. */}
        <TokenCard token={token} trigger={container === undefined ? trigger : null} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * What the token is, for the popover: identity, how far it can be trusted, its address and its explorer page; for SIDE,
 * Get SIDE, which opens the SIDE sheet and returns focus to `trigger` (null inside a sheet, where it is left out).
 */
function TokenCard({ token, trigger }: { token: string; trigger: RefObject<HTMLButtonElement | null> | null }) {
  const sheet = useSideSheet()
  const a = token.toLowerCase()
  const meta = tokenMeta(a)
  const listed = TOKEN_LOGOS[`${chain.id}:${a}`]
  const source = tokenSource(a)
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-2.5">
      <div className="flex items-center gap-2.5">
        <TokenIcon token={a} className="size-8 align-middle text-base" />
        <div className="grid min-w-0">
          <span className="truncate font-medium">{meta?.symbol ?? listed?.symbol ?? 'Unknown token'}</span>
          <span className="truncate text-xs text-muted-foreground">
            {meta?.name ?? listed?.name ?? 'Name unavailable'}
          </span>
        </div>
      </div>
      <p className={cn('text-xs', source === 'unlisted' ? 'text-warning-text' : 'text-muted-foreground')}>
        {SOURCE[source]}
      </p>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(token).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            },
            () => undefined,
          )
        }
        className="-mx-1 rounded-md px-1 py-0.5 text-left font-mono text-xs break-all text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Copy token address"
      >
        {copied ? 'Copied' : token}
      </button>
      <a
        href={tokenExplorer(token)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
      >
        <img src={MONAD_BADGE} alt="" aria-hidden className="size-4" />
        View on {chain.blockExplorers?.default.name ?? 'the explorer'}
        <ExternalLink aria-hidden className="size-3.5 text-muted-foreground" />
      </a>
      {sheet !== null && trigger !== null && a === sideToken?.toLowerCase() && (
        <PopoverPrimitive.Close
          className="inline-flex items-center gap-1.5 text-left text-sm font-medium text-foreground hover:underline"
          onClick={() => sheet.open({ returnFocus: trigger.current })}
        >
          Get SIDE
        </PopoverPrimitive.Close>
      )}
    </div>
  )
}
