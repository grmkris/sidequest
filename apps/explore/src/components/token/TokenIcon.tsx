/**
 * A token's icon, chosen by address only — never by symbol, since anyone can deploy a token called "USDC":
 * the tokens Sidequest deploys (drawn), then a logo vendored from Monad's token list or web3icons (`scripts/tokens.ts`),
 * else a letter disc with a dot when the token is not one Sidequest lists. Decorative: it adds no text to its line.
 */
import { isListedToken, tokenMeta } from '../../format.ts'
import { sidequest } from '../../sidequest.ts'
import { cn } from '../../lib/cn.ts'
import { TOKEN_LOGOS } from '../../tokens.generated.ts'
import { chain, deployment } from '../../wallet.ts'
import { FactoryIcon, MeurIcon, MusdIcon } from './builtin.tsx'

export type TokenSource = 'sidequest' | 'monad-list' | 'web3icons' | 'unlisted'

/** Where a token's identity comes from: Sidequest's own list, a public token list, or nowhere (unverified). */
/** SIDE by address: the deployment's, and v1's where a deployment names it separately. */
const isFactory = (a: string) => a === deployment.factory.toLowerCase() || a === sidequest?.factory.toLowerCase()

export function tokenSource(address: string): TokenSource {
  const a = address.toLowerCase()
  if (isListedToken(a) || isFactory(a)) return 'sidequest'
  return TOKEN_LOGOS[`${chain.id}:${a}`]?.source ?? 'unlisted'
}

/** The icon for an address: a drawn one, a vendored logo's path, or null for the letter disc. */
function tokenIcon(
  address: string,
): { kind: 'drawn'; Icon: typeof FactoryIcon } | { kind: 'logo'; src: string } | null {
  const a = address.toLowerCase()
  if (isFactory(a)) return { kind: 'drawn', Icon: FactoryIcon }
  // A listed token's symbol is ours (format.ts TOKENS), so it can pick a drawn icon; an unlisted one's cannot.
  if (isListedToken(a)) {
    const symbol = tokenMeta(a)?.symbol
    if (symbol === 'mUSD') return { kind: 'drawn', Icon: MusdIcon }
    if (symbol === 'mEUR') return { kind: 'drawn', Icon: MeurIcon }
  }
  if (TOKEN_LOGOS[`${chain.id}:${a}`] !== undefined) return { kind: 'logo', src: `/tokens/${chain.id}/${a}.png` }
  return null
}

/** The disc's hue, spread by address so neighbouring tokens differ (the same FNV-1a as agent monograms). */
function hue(seed: string): number {
  let x = 0x811c9dc5
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193)
  return (x >>> 0) % 360
}

export function TokenIcon({ token, className }: { token: string; className?: string }) {
  const icon = tokenIcon(token)
  const box = cn('inline-block size-[1.15em] shrink-0 rounded-full align-[-0.22em]', className)
  if (icon?.kind === 'drawn') return <icon.Icon className={box} />
  if (icon?.kind === 'logo')
    return (
      <img
        src={icon.src}
        alt=""
        aria-hidden
        draggable={false}
        className={cn(box, 'bg-muted object-contain select-none')}
      />
    )
  const a = token.toLowerCase()
  const symbol = tokenMeta(a)?.symbol ?? '?'
  const h = hue(a)
  // The letter is a pseudo-element (data-label), so the disc adds no text to the amount beside it. It is laid out
  // absolutely and smaller than the line: the disc keeps the line's font size (its size, offset and dot are in em) and,
  // with no content in flow, sits on its bottom edge like the drawn and logo icons.
  return (
    <span
      aria-hidden
      data-label={symbol.replace(/^\$/, '').slice(0, 1).toUpperCase()}
      className={cn(
        box,
        'relative leading-none font-bold before:absolute before:inset-0 before:grid before:place-items-center before:text-[0.62em] before:content-[attr(data-label)]',
      )}
      style={{
        background: `linear-gradient(140deg, hsl(${h} 55% 52%), hsl(${(h + 40) % 360} 50% 40%))`,
        color: 'var(--ink-on-color)',
      }}
    >
      {tokenSource(a) === 'unlisted' && (
        <span className="absolute -top-px -right-px size-[0.42em] rounded-full bg-warning ring-1 ring-background" />
      )}
    </span>
  )
}
