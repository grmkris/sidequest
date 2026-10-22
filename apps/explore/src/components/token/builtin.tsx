/**
 * The icons of the tokens Sidequest itself deploys, drawn here rather than vendored: SIDE (the Sidequest mark on its
 * ink) and the testnet's mUSD and mEUR. The test tokens are a $ and a € on muted green and blue under a diagonal
 * hatch, so they never pass for USDC or EURC. Paths only (no SVG <text>): an icon adds no text to the line it sits in.
 */
import { type SVGProps, useId } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>

const svg = (props: IconProps) => ({ viewBox: '0 0 32 32', focusable: false, ...props }) as const

export function FactoryIcon(props: IconProps) {
  return (
    <svg aria-hidden {...svg(props)}>
      {/* The Sidequest mark in the page's ink: near-black on light, inverted on dark, like the favicon. */}
      <circle cx="16" cy="16" r="16" className="fill-foreground" />
      <path
        d="M8 9h8l8 8M24 23h-8l-8-8"
        className="stroke-background"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

/** A test token's disc: its colour, a 45° hatch (the "not real money" mark) and a glyph drawn in a 24-unit box. */
function TestToken({ fill, glyph, ...props }: IconProps & { fill: string; glyph: string[] }) {
  // Unique per instance: several chips on one page each carry their own pattern.
  const id = `hatch${useId().replaceAll(':', '')}`
  return (
    <svg aria-hidden {...svg(props)}>
      <defs>
        <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="4" fill="#fff" fillOpacity="0.14" />
        </pattern>
      </defs>
      <circle cx="16" cy="16" r="16" fill={fill} />
      <circle cx="16" cy="16" r="16" fill={`url(#${id})`} />
      <g
        transform="translate(5 5) scale(0.9167)"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {glyph.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  )
}

// Glyphs from Lucide (ISC): dollar-sign and euro.
const DOLLAR = ['M12 2v20', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']
const EURO = ['M4 10h12', 'M4 14h9', 'M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2']

export const MusdIcon = (props: IconProps) => <TestToken {...props} fill="#3d8a68" glyph={DOLLAR} />
export const MeurIcon = (props: IconProps) => <TestToken {...props} fill="#3c6aa8" glyph={EURO} />
