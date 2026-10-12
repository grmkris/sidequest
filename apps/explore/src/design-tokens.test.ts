/**
 * Guards the design tokens in styles.css (after myplan's tests/design/contrast.test.ts): text on page, card and muted
 * reaches WCAG 4.5:1, the focus ring 3:1, borders stay visible, status text reads on its own 12% tint, and the two
 * copies of the dark theme (system setting and `data-theme='dark'`) stay identical. Parses the oklch() values directly.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block`)
  const end = css.indexOf('}', start)
  const out: Record<string, string> = {}
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim()
  return out
}

type Rgb = [number, number, number]

/** oklch → linear sRGB, clamped to the gamut. */
function oklchToLinear(value: string): Rgb {
  const m = /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value)
  if (m === null) throw new Error(`not oklch: ${value}`)
  const L = Number(m[1])
  const C = Number(m[2])
  const h = (Number(m[3]) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ]
  return rgb.map((c) => Math.min(1, Math.max(0, c))) as Rgb
}

const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** `color-mix(in oklab, color share%, transparent)` over an opaque surface, blended as the browser does (encoded sRGB). */
function tint(color: string, share: number, surface: string): Rgb {
  const fg = oklchToLinear(color).map(encode)
  const bg = oklchToLinear(surface).map(encode)
  return fg.map((c, i) => decode(c * share + bg[i]! * (1 - share))) as Rgb
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const contrast = (a: string, b: string) => ratio(oklchToLinear(a), oklchToLinear(b))

const colourTokens = (t: Record<string, string>) =>
  Object.keys(t)
    .filter((k) => k !== 'radius')
    .toSorted()

const light = block(':root')
const dark = block(":root[data-theme='dark']")

describe('dark theme', () => {
  it('is the same under the system setting and under data-theme', () => {
    expect(block(":root:not([data-theme='light'])")).toEqual(dark)
  })
  it('defines every light token', () => {
    expect(colourTokens(dark)).toEqual(colourTokens(light))
  })
})

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast', (_name, t) => {
  it('body and muted text on page, card and muted meet 4.5:1', () => {
    for (const surface of ['background', 'card', 'muted', 'sidebar']) {
      expect(contrast(t.foreground!, t[surface]!)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['muted-foreground']!, t[surface]!)).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('primary buttons are legible', () => {
    expect(contrast(t['primary-foreground']!, t.primary!)).toBeGreaterThanOrEqual(4.5)
  })
  it('status text meets 4.5:1 on card, muted and its own tint', () => {
    for (const [base, text, share] of [
      ['success', 'success-text', 0.12],
      ['warning', 'warning-text', 0.14],
      ['info', 'info-text', 0.12],
      ['destructive', 'destructive-text', 0.12],
    ] as const) {
      expect(contrast(t[text]!, t.card!)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t[text]!, t.muted!)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(oklchToLinear(t[text]!), tint(t[base]!, share, t.card!))).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('the focus ring reaches 3:1 on the page', () => {
    expect(contrast(t.ring!, t.background!)).toBeGreaterThanOrEqual(3)
  })
  it('solid status fills carry the page colour as text (count badges, timeline marks)', () => {
    for (const token of ['success-text', 'warning-text', 'info-text', 'destructive-text'])
      expect(contrast(t.background!, t[token]!)).toBeGreaterThanOrEqual(4.5)
  })
  it('status dots read against the page', () => {
    for (const token of ['success', 'info', 'destructive'])
      expect(contrast(t[token]!, t.background!)).toBeGreaterThanOrEqual(3)
  })
  it('borders are visible and cards sit above the page', () => {
    expect(contrast(t.border!, t.background!)).toBeGreaterThanOrEqual(1.3)
    expect(contrast(t.card!, t.background!)).toBeGreaterThan(1.02)
  })
})

/** Every .tsx under src, to check the classes as rendered rather than the tokens alone. */
const sources = (readdirSync(new URL('.', import.meta.url), { recursive: true, encoding: 'utf8' }) as string[])
  .filter((file) => file.endsWith('.tsx'))
  .map((file) => [file, readFileSync(new URL(file, import.meta.url), 'utf8')] as const)

describe('status colours as rendered', () => {
  it('writes literal string children as plain JSX text', () => {
    // AGENT-PROFILE rewrites these two files after S5 lands; leave its owned source alone.
    const offenders = sources.flatMap(([file, text]) =>
      [...text.matchAll(/>\{'[^'{}]*'\}</g)].map((match) => `${file}: ${match[0]}`),
    )
    expect(offenders).toEqual([])
  })
  it('text uses the -text shade: the base shade is for dots and tints, below 4.5:1 as text (VV2-010)', () => {
    const offenders = sources.flatMap(([file, text]) =>
      [...text.matchAll(/\btext-(info|success|warning|destructive)(?:\/\d+)?\b(?!-)/g)].map((m) => `${file}: ${m[0]}`),
    )
    expect(offenders).toEqual([])
  })
  it('white text appears only on the decorative monogram gradients: a solid status fill takes text-background (VV2-010)', () => {
    const offenders = sources
      .filter(([file, text]) => /\btext-white\b/.test(text) && !file.endsWith('components/Wallet.tsx'))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
  it('defines no legacy design tokens or utilities', () => {
    const legacyColours = [
      'tint',
      'on-tint',
      'bg',
      'surface',
      'surface-2',
      'fill',
      'fill-strong',
      'label',
      'label-2',
      'label-3',
      'sep',
      'bar',
      'side',
      'scrim',
      'ok',
      'ok-bg',
      'warn',
      'warn-bg',
      'info-bg',
      'bad',
      'bad-bg',
      'gray',
      'gray-bg',
      'code',
    ]
    const token = new RegExp(
      `--(?:color-)?(?:${legacyColours.join('|')}):|--(?:ease-spring|shadow-float|radius-group):`,
      'g',
    )
    expect([...css.matchAll(token)].map((match) => match[0])).toEqual([])
    expect(css).not.toMatch(/@utility\s+(?:press|material|tabular)\s*\{|\.(?:eyebrow|action-link)\b/)
  })
  it('uses only current utilities and direct component imports throughout source', () => {
    const colours =
      'tint|on-tint|bg|surface(?:-2)?|fill(?:-strong)?|label(?:-[23])?|sep|bar|side|scrim|ok(?:-bg)?|warn(?:-bg)?|info-bg|bad(?:-bg)?|gray(?:-bg)?|code|good'
    const utility = new RegExp(
      `\\b(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|accent|outline|divide)-(?:${colours})(?![\\w-])|\\bshadow-float\\b|(?<![\\w-])(?:press|material|tabular|eyebrow|action-link)(?![\\w-])|(?:tracking|leading)-\\[[^\\]]+\\]|--ease-spring`,
      'g',
    )
    const files = (
      readdirSync(new URL('.', import.meta.url), { recursive: true, encoding: 'utf8' }) as string[]
    ).filter((file) => /\.(?:ts|tsx|css)$/.test(file) && file !== 'design-tokens.test.ts')
    const offenders = files.flatMap((file) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
      return [...source.matchAll(utility), ...source.matchAll(/(?:from|import)\s*['"][^'"]*\/ui(?:\.tsx)?['"]/g)].map(
        (match) => `${file}: ${match[0]}`,
      )
    })
    expect(offenders).toEqual([])
  })
})

describe('page width', () => {
  it('is set once, by the shells: a page narrows its body with its route measure, never with its own cap', () => {
    const shells = ['components/Shell.tsx', 'components/LandingShell.tsx', 'routes/Embed.tsx']
    const offenders = sources.flatMap(([file, text]) =>
      shells.includes(file) ? [] : [...text.matchAll(/\bmax-w-[3-7]xl\b/g)].map((match) => `${file}: ${match[0]}`),
    )
    expect(offenders).toEqual([])
  })
})
