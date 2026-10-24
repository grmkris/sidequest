/**
 * Vendors the token logos Explore's token chips show, by chain and address only (never by symbol: anyone can name a
 * token "USDC"):
 *
 * - every token on Monad's official token list (`@monad-crypto/token-list`, both networks), and
 * - any token web3icons lists with a Monad address (`@web3icons/common` metadata; none yet), its SVG taken from the
 *   same release of `@web3icons/core` on jsDelivr, plus web3icons' Monad network mark (the explorer badge).
 *
 * Each logo is drawn by the headless Chromium playwright-core already brings, as an <img> (where an SVG never runs
 * script) on a page that may make no request at all, into a transparent 96 px PNG: no third-party SVG is ever served from our origin, and the page's CSP
 * (`img-src 'self'`) holds. The PNGs and `src/tokens.generated.ts` are committed. Run by hand after bumping either
 * package (`bun apps/explore/scripts/tokens.ts`); a logo that cannot be fetched is skipped and listed, and the chip
 * then draws its letter disc.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mainnetTokenList, testnetTokenList } from '@monad-crypto/token-list'
import { networks, tokens as web3Tokens } from '@web3icons/common'
import { chromium } from 'playwright-core'

const SIZE = 96
const WEB3ICONS_CORE = '4.0.58'
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const pkg = (name: string) =>
  (JSON.parse(readFileSync(here(`../node_modules/${name}/package.json`), 'utf8')) as { version: string }).version

interface Source {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  source: 'monad-list' | 'web3icons'
  fetch: () => Promise<{ mime: string; bytes: Uint8Array }>
}

async function get(url: string): Promise<{ mime: string; bytes: Uint8Array }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > 512_000) throw new Error(`too large: ${url}`)
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase()
  const mime =
    ext === 'svg'
      ? 'image/svg+xml'
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ''
  if (mime === '') throw new Error(`unknown image type: ${url}`)
  return { mime, bytes }
}

/** A web3icons SVG, read out of its ES module (`var x = '<svg…>'; export { x as default }`) without running it. */
async function web3icon(kind: 'tokens' | 'networks', name: string): Promise<{ mime: string; bytes: Uint8Array }> {
  for (const variant of ['branded', 'background', 'mono']) {
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/@web3icons/core@${WEB3ICONS_CORE}/dist/svgs/${kind}/${variant}/${name}.svg.js`,
      { signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) continue
    const literal = /=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(await res.text())?.[1]
    if (literal === undefined) continue
    const svg = JSON.parse(
      literal.startsWith("'") ? `"${literal.slice(1, -1).replaceAll('"', '\\"').replaceAll("\\'", "'")}"` : literal,
    ) as string
    if (svg.trimStart().startsWith('<svg')) return { mime: 'image/svg+xml', bytes: new TextEncoder().encode(svg) }
  }
  throw new Error(`no web3icons ${kind} icon ${name}`)
}

const sources: Source[] = []
for (const list of [mainnetTokenList, testnetTokenList]) {
  for (const t of list.tokens) {
    if (t.logoURI === undefined) continue
    const logo = t.logoURI
    sources.push({
      chainId: t.chainId,
      address: t.address.toLowerCase(),
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      source: 'monad-list',
      fetch: () => get(logo),
    })
  }
}
// web3icons networks for Monad, by their metadata id; then any token with an address on one of them.
const monadNetworks = new Map(
  networks.filter((n) => n.chainId === 143 || n.chainId === 10143).map((n) => [n.id, n.chainId as number]),
)
for (const t of web3Tokens) {
  for (const [network, address] of Object.entries(t.addresses ?? {})) {
    const chainId = monadNetworks.get(network)
    if (chainId === undefined || typeof address !== 'string') continue
    const key = address.toLowerCase()
    if (sources.some((s) => s.chainId === chainId && s.address === key)) continue
    const file = t.filePath.replace(/^token:/, '')
    sources.push({
      chainId,
      address: key,
      symbol: t.symbol.toUpperCase(),
      name: t.name,
      decimals: 18,
      source: 'web3icons',
      fetch: () => web3icon('tokens', file),
    })
  }
}

const out = here('../public/tokens')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
// Keep a network route: untrusted logo rendering must make no network request; every page uses an in-page data URL.
await context.route('**/*', (route) => route.abort())

async function render(image: { mime: string; bytes: Uint8Array }, path: string) {
  const page = await context.newPage()
  const src = `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${src}" style="display:block;width:${SIZE}px;height:${SIZE}px;object-fit:contain"></body></html>`,
  )
  if (!(await page.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)))
    throw new Error('image did not decode')
  await page.screenshot({ path, clip: { x: 0, y: 0, width: SIZE, height: SIZE }, omitBackground: true })
  await page.close()
}

const entries: Array<[string, { symbol: string; name: string; decimals: number; source: Source['source'] }]> = []
const skipped: string[] = []
for (const s of sources) {
  try {
    mkdirSync(`${out}/${s.chainId}`, { recursive: true })
    await render(await s.fetch(), `${out}/${s.chainId}/${s.address}.png`)
    entries.push([
      `${s.chainId}:${s.address}`,
      { symbol: s.symbol, name: s.name, decimals: s.decimals, source: s.source },
    ])
  } catch (error) {
    skipped.push(`${s.chainId}:${s.address} ${s.symbol} (${(error as Error).message})`)
  }
}
await render(await web3icon('networks', 'monad'), `${out}/monad.png`)
await browser.close()

entries.sort(([a], [b]) => a.localeCompare(b))
writeFileSync(
  here('../src/tokens.generated.ts'),
  `// Generated by apps/explore/scripts/tokens.ts from @monad-crypto/token-list ${pkg('@monad-crypto/token-list')}, @web3icons/common ${pkg('@web3icons/common')}
// and @web3icons/core ${WEB3ICONS_CORE}. Do not edit; rerun the script. Logos: public/tokens/<chainId>/<address>.png.

/** Tokens with a vendored logo, keyed \`<chainId>:<lowercase address>\`. Being on a list is not Sidequest's endorsement. */
export const TOKEN_LOGOS: Readonly<Record<string, { symbol: string; name: string; decimals: number; source: 'monad-list' | 'web3icons' }>> = ${JSON.stringify(Object.fromEntries(entries), null, 2)}

/** web3icons' Monad mark, for explorer links. */
export const MONAD_BADGE = '/tokens/monad.png'
`,
)
console.log(`${entries.length} logos, ${skipped.length} skipped`)
for (const s of skipped) console.log(`  skipped ${s}`)
