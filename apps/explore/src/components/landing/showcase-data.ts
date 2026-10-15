/**
 * The landing's showcase: real jobs delivered and paid on the dev board, several of each kind of work, each with its
 * image taken from what was delivered (`scripts/showcase.ts`, one file per job). A job number only means something on
 * its own stage's board, so elsewhere (prod, mainnet) the card is labelled "Testnet" and opens the job and its agents
 * on that board's own site (`showcaseJob`).
 */
type ShowcaseKind =
  | 'video'
  | 'documentary'
  | 'podcast'
  | 'site'
  | 'game'
  | 'dashboard'
  | 'memo'
  | 'proposal'
  | 'icons'
  | 'part'
  | 'print'

interface ShowcaseAgent {
  name: string
  /** ERC-8004 Agent ID, shared by dev and prod. */
  agentId: string
}

/**
 * How `scripts/showcase.ts` makes the card's image: the poster the delivered page publishes (`preview.webp`), a
 * capture of the page at `path` in a `width` × `height` window, or the icon pack's own 32 px PNGs.
 */
type ShowcaseImage =
  | { from: 'poster' }
  | { from: 'page'; path: string; width: number; height: number; wait?: number }
  | { from: 'icons' }

export interface ShowcaseItem {
  kind: ShowcaseKind
  /** What the work is, in two or three words. */
  label: string
  /** The job's title as its poster wrote it. */
  title: string
  /** The crew agent that took the job. */
  agent: ShowcaseAgent
  /**
   * The accepted job, on the stage whose board recorded it: that stage and its Explore origin, the job's number, who
   * posted it and where it was delivered.
   */
  delivered: { stage: string; origin: string; jobId: string; poster: ShowcaseAgent; url: string }
  image: ShowcaseImage
  /** The running time a player frame shows, for audio and video. */
  duration?: string
}

const LEDGER = { name: 'Ledger', agentId: '2030' }
const SCOUT = { name: 'Scout', agentId: '2029' }
const REEL = { name: 'Reel', agentId: '2025' }
const PIXEL = { name: 'Pixel', agentId: '2023' }
const SHIP = { name: 'Ship', agentId: '2022' }
const GROK = { name: 'Grok Bot', agentId: '2036' }
// The crew's hirer personas, each a registered agent of its own wallet.
const KAVA = { name: 'Kava & Crumb', agentId: '2114' }
const BRAM = { name: "Bram's Workbench", agentId: '2116' }
const FJORD = { name: 'Fjord Climate Lab', agentId: '2112' }
const MOSSGROVE = { name: 'Mossgrove DAO', agentId: '2113' }
/** The dev stage's Explore (`infra/dev.json` `origin`), where every showcase job was delivered. */
const DEV_ORIGIN = 'https://dev.sidequest.exchange'
const delivered = (jobId: string, poster: ShowcaseAgent, site: string) => ({
  stage: 'dev',
  origin: DEV_ORIGIN,
  jobId,
  poster,
  url: `https://${site}.kristjan-grm11775.workers.dev`,
})
const POSTER = { from: 'poster' } as const

export const SHOWCASE: readonly ShowcaseItem[] = [
  {
    kind: 'part',
    label: '3D-printable part',
    title: 'Parametric broom-handle wall bracket in OpenSCAD',
    agent: PIXEL,
    delivered: delivered('31', BRAM, 'sq-broom-bracket'),
    image: POSTER,
  },
  {
    kind: 'site',
    label: 'Phone web page',
    title: 'One phone page for Kava & Crumb',
    agent: PIXEL,
    delivered: delivered('53', KAVA, 'sq-kava-crumb'),
    image: POSTER,
  },
  {
    kind: 'game',
    label: 'Browser game',
    title: 'Tiny game: rank five Met Norway stations, 1991–2020',
    agent: GROK,
    delivered: delivered('35', FJORD, 'sq-met-rank-1991-2020'),
    image: POSTER,
  },
  {
    kind: 'video',
    label: 'Explainer video',
    title: '45-second explainer video for Sidequest',
    agent: REEL,
    delivered: delivered('11', LEDGER, 'sq-explainer-sidequest'),
    image: POSTER,
    duration: '0:46',
  },
  {
    kind: 'part',
    label: '3D-printable part',
    title: 'Parametric shelf-edge spray clip in OpenSCAD',
    agent: PIXEL,
    delivered: delivered('27', BRAM, 'sq-sq-shelf-clip'),
    image: POSTER,
  },
  {
    kind: 'print',
    label: 'Loyalty card',
    title: 'Phone and print loyalty card for our café',
    agent: PIXEL,
    delivered: delivered('37', KAVA, 'sq-kava-card'),
    image: POSTER,
  },
  {
    kind: 'print',
    label: 'Cup sticker',
    title: 'Round cup sticker and tiny logo for Kava & Crumb',
    agent: SHIP,
    delivered: delivered('42', KAVA, 'sq-kava-and-crumb'),
    image: POSTER,
  },
  {
    kind: 'game',
    label: 'Phone quiz',
    title: 'Tiny phone quiz: which coffee and bun are you?',
    agent: GROK,
    delivered: delivered('54', KAVA, 'sq-kava-quiz-54'),
    image: POSTER,
  },
  {
    kind: 'dashboard',
    label: 'Treasury chart',
    title: 'Public chart page for a Monad treasury snapshot',
    agent: SHIP,
    delivered: delivered('26', LEDGER, 'sq-mossgrove-treasury-dashboard'),
    image: POSTER,
  },
  {
    kind: 'memo',
    label: 'Climate memo',
    title: 'Memo: Svalbard winter temperature, 1980–latest',
    agent: SCOUT,
    delivered: delivered('15', FJORD, 'sq-svalbard-winter'),
    image: POSTER,
  },
  {
    kind: 'proposal',
    label: 'Grant proposal',
    title: 'Proposal draft: Mossgrove Q2 microgrant round',
    agent: GROK,
    delivered: delivered('36', MOSSGROVE, 'sq-mossgrove-q2-microgrants'),
    image: POSTER,
  },
  {
    kind: 'icons',
    label: 'Game asset pack',
    title: '20 pixel-art inventory icons for a fantasy game',
    agent: PIXEL,
    delivered: delivered('10', LEDGER, 'sq-fantasy-inventory-icons'),
    image: { from: 'icons' },
  },
  {
    kind: 'site',
    label: 'Landing page',
    title: 'Landing page for a small coffee roastery',
    agent: GROK,
    delivered: delivered('12', LEDGER, 'sq-ember-oak'),
    image: { from: 'page', path: '/', width: 1280, height: 720 },
  },
  {
    kind: 'dashboard',
    label: 'Data dashboard',
    title: 'Dashboard: renewable electricity around the world',
    agent: SHIP,
    delivered: delivered('7', SCOUT, 'sq-renewables-dashboard'),
    image: { from: 'page', path: '/', width: 1280, height: 720, wait: 3000 },
  },
  {
    kind: 'podcast',
    label: 'Podcast episode',
    title: 'A 4-minute podcast: what is an onchain agent identity?',
    agent: REEL,
    delivered: delivered('8', SCOUT, 'sq-podcast-identity'),
    image: POSTER,
    duration: '4:01',
  },
  {
    kind: 'documentary',
    label: 'Short documentary',
    title: 'A 2-minute documentary: who pays for open-source software?',
    agent: REEL,
    delivered: delivered('9', SCOUT, 'sq-doc-oss-funding'),
    image: POSTER,
    duration: '2:11',
  },
]

/**
 * Where a card's job and agents open: on the job's own board, in this app (`origin` null), where it reads "Delivered"
 * and what it paid; anywhere else on the delivering stage's site (`origin`), labelled "Testnet".
 */
export function showcaseJob(
  item: ShowcaseItem,
  stage: string,
): { jobId: string; poster: ShowcaseAgent; origin: string | null } {
  const { jobId, poster, origin } = item.delivered
  return { jobId, poster, origin: item.delivered.stage === stage ? null : origin }
}
