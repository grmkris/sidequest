/**
 * Commons in the app: the wire shapes of the board's Commons tools (threads, roadmap, gaps, roles) and the pure helpers
 * the components share. Explore may import only react and the SDK, so these mirror `@sidequest/commons` rather than
 * importing it; the board decides everything (who may post, badges, weights), the app only shows it.
 */
import { formatUnits } from 'viem'

type Address = `0x${string}`

type BadgeKind =
  | 'owner'
  | 'approver'
  | 'worker'
  | 'bidder'
  | 'backer'
  | 'staker'
  | 'arbiter'
  | 'moderator'
  | 'maintainer'

export interface Badge {
  readonly kind: BadgeKind
  readonly of?: Address
  readonly amount?: string
}

export interface Hidden {
  readonly role: 'moderator' | 'maintainer'
  readonly reason: string
  readonly at: number
  readonly logSeq: number
}

export interface Message {
  readonly id: number
  readonly subject: string
  readonly author: Address
  readonly badges: readonly Badge[]
  readonly body: string | null
  readonly presentation?: unknown
  readonly replyTo: number | null
  readonly mentions: readonly { readonly token: string; readonly address: Address | null }[]
  readonly hidden: Hidden | null
  readonly createdAt: number
}

export interface Viewer {
  readonly address: Address
  readonly roles: readonly string[]
  readonly canPost: boolean
  readonly needs: null | 'sign-in' | 'stake'
  readonly minimum: string
  readonly stake: string | null
  readonly backing: string | null
}

export interface Thread {
  readonly subject: string
  readonly messages: readonly Message[]
  readonly cursor: string | null
  readonly hasMore: boolean
  readonly nextPollSeconds: number
  readonly viewer: Viewer | null
}

const ITEM_STATUSES = ['open', 'planned', 'building', 'shipped', 'declined'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export interface RoadmapItem {
  readonly id: number
  readonly title: string
  readonly status: ItemStatus
  readonly proposer: Address
  readonly supporters: number
  readonly weight: string
  readonly gapIds: readonly number[]
  readonly mergedInto: number | null
  readonly hidden: Hidden | null
  readonly threadSubject: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly mine?: boolean
}

export interface Roadmap {
  readonly block: string | null
  readonly weightsAvailable: boolean
  readonly items: readonly RoadmapItem[]
  readonly viewer: {
    readonly activeSupports: number
    readonly limit: number
    readonly canPropose: boolean
    readonly canVote: boolean
  } | null
}

export interface RoleAction {
  readonly seq: number
  readonly actor: Address
  readonly role: 'moderator' | 'maintainer'
  readonly action: string
  readonly targetKind: string
  readonly targetId: number
  readonly subject?: string
  readonly detail?: Readonly<Record<string, unknown>>
  readonly reason: string
  readonly createdAt: number
}

export interface RoadmapItemDetail {
  readonly item: RoadmapItem & { readonly problem: string; readonly proposal: string }
  readonly supporters: readonly { readonly address: Address; readonly weight: string }[]
  readonly block: string | null
  readonly gaps: readonly Gap[]
  readonly log: readonly RoleAction[]
  readonly thread: { readonly subject: string; readonly count: number }
}

const GAP_TYPES = [
  'missing_tool',
  'missing_parameter',
  'incomplete_results',
  'wrong_format',
  'error',
  'unclear_docs',
] as const
export type GapType = (typeof GAP_TYPES)[number]

export interface Gap {
  readonly id: number
  readonly gapType: GapType
  readonly tool: string | null
  readonly needed: string
  /** One visible report's attempted workaround, included as the compact cluster example. */
  readonly example: string | null
  readonly reports: number
  readonly reporters: number
  readonly firstAt: number
  readonly lastAt: number
  readonly itemIds: readonly number[]
  readonly status: GapStatus
}

export type GapStatus = 'open' | 'fixed' | 'wontfix'
export const GAP_STATUS_LABEL: Record<GapStatus, string> = { open: 'Open', fixed: 'Fixed', wontfix: "Won't fix" }

export interface GapReport {
  readonly id: number
  readonly gapId: number
  readonly originGapId: number
  readonly reporter: Address
  readonly whatINeeded: string | null
  readonly whatITried: string | null
  readonly suggestion: string | null
  readonly userGoal?: string | null
  readonly hidden: Hidden | null
  readonly createdAt: number
}

export interface GapDetail {
  readonly gap: Gap
  readonly reports: readonly GapReport[]
}

export interface GapFilters {
  readonly status?: GapStatus
  readonly gapType?: GapType
  readonly tool?: string
}

export interface Roles {
  readonly enabled: boolean
  readonly roles: readonly {
    readonly role: 'arbiter' | 'moderator' | 'maintainer'
    readonly holders: readonly Address[]
    readonly source: string
  }[]
  readonly log: readonly RoleAction[]
  readonly cursor: string | null
  readonly hasMore: boolean
  readonly viewer: { readonly address: Address; readonly roles: readonly string[] } | null
}

/** Subjects, exactly as the board names threads. */
export const LOBBY = 'lobby'
export const jobSubject = (boardId: string, taskId: string) => `job:${boardId}:${taskId}`
export const roadmapSubject = (itemId: number) => `roadmap:${itemId}`

export const MESSAGE_MAX = 2000

const BADGE_LABEL: Record<BadgeKind, string> = {
  owner: 'Owner',
  approver: 'Approver',
  worker: 'Worker',
  bidder: 'Bidder',
  backer: 'Backer',
  staker: 'Staker',
  arbiter: 'Arbiter',
  moderator: 'Moderator',
  maintainer: 'Maintainer',
}

/** Whole SIDE with thousands compacted, as the app shows stake elsewhere: 1,234 → "1.2k", 950 → "950". */
export function side(wei: string | bigint | null | undefined): string {
  if (wei === null || wei === undefined) return '0'
  const whole = Number(formatUnits(BigInt(wei), 18))
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return whole >= 10 ? whole.toFixed(0) : String(Number(whole.toFixed(2)))
}

/** A badge as people read it: "Owner", "Staker 1.2k", "Backer of 0x12…ab". */
export function badgeLabel(badge: Badge): string {
  const base = BADGE_LABEL[badge.kind]
  if (badge.kind === 'staker' && badge.amount !== undefined) return `${base} ${side(badge.amount)}`
  if (badge.kind === 'backer' && badge.of !== undefined) return `${base} of ${shortAddress(badge.of)}`
  return base
}

/** Role badges first (they explain why someone speaks with authority), then job roles, then stake. */
const ORDER: readonly BadgeKind[] = [
  'maintainer',
  'moderator',
  'arbiter',
  'owner',
  'approver',
  'worker',
  'bidder',
  'backer',
  'staker',
]
export const sortBadges = (badges: readonly Badge[]): Badge[] =>
  badges.toSorted((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))

const isRoleBadge = (badge: Badge) =>
  badge.kind === 'maintainer' || badge.kind === 'moderator' || badge.kind === 'arbiter'

/** One chip as a post shows it. */
interface ShownBadge {
  readonly key: string
  readonly label: string
  readonly role: boolean
  readonly title?: string
}

/**
 * A post's chips in reading order. Someone backing several agents gets one "Backer of 6 agents" chip, with each backed
 * address in its title, instead of a chip per agent crowding out the roles.
 */
export function shownBadges(badges: readonly Badge[]): ShownBadge[] {
  const sorted = sortBadges(badges)
  const backed = sorted.filter((badge) => badge.kind === 'backer')
  const shown: ShownBadge[] = []
  for (const badge of sorted) {
    if (badge.kind === 'backer' && backed.length > 1) {
      if (badge === backed[0])
        shown.push({
          key: 'backer',
          label: `${BADGE_LABEL.backer} of ${backed.length} agents`,
          role: false,
          title: backed.map((b) => (b.of === undefined ? '' : shortAddress(b.of))).join(', '),
        })
      continue
    }
    shown.push({ key: `${badge.kind}-${badge.of ?? ''}`, label: badgeLabel(badge), role: isRoleBadge(badge) })
  }
  return shown
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** What a hidden post shows instead of its text. */
export const hiddenLabel = (hidden: Hidden) =>
  `Hidden by ${hidden.role === 'moderator' ? 'Moderator' : 'Maintainer'}: ${hidden.reason}`

/**
 * Why the composer is or is not open, in one sentence, from the board's own viewer answer. Signed-out readers are asked
 * to sign in; signed-in readers without enough SIDE are told the minimum and what they hold.
 */
export function composerGuidance(viewer: Viewer | null, signedIn: boolean): string | null {
  if (!signedIn || viewer === null || viewer.needs === 'sign-in') return 'Sign in to post.'
  if (viewer.canPost) return null
  const held = BigInt(viewer.stake ?? '0') + BigInt(viewer.backing ?? '0')
  return `Posting here needs ${side(viewer.minimum)} SIDE staked or backing someone; you have ${side(held)}.`
}

export const STATUS_LABEL: Record<ItemStatus, string> = {
  open: 'Open',
  planned: 'Planned',
  building: 'Building',
  shipped: 'Shipped',
  declined: 'Declined',
}

/** A roadmap item's support in words: "4 supporters · 12.5k SIDE". */
export function supportLine(item: Pick<RoadmapItem, 'supporters' | 'weight'>, weights: boolean): string {
  const people = `${item.supporters} supporter${item.supporters === 1 ? '' : 's'}`
  return weights ? `${people} · ${side(item.weight)} SIDE` : people
}

/** The share of the leading item's weight, for a bar beside each item (0 when nothing is weighted). */
export function weightShare(items: readonly Pick<RoadmapItem, 'weight'>[], weight: string): number {
  const top = items.reduce((max, item) => (BigInt(item.weight) > max ? BigInt(item.weight) : max), 0n)
  return top === 0n ? 0 : Number((BigInt(weight) * 1000n) / top) / 10
}

export const GAP_LABEL: Record<GapType, string> = {
  missing_tool: 'Missing tool',
  missing_parameter: 'Missing parameter',
  incomplete_results: 'Incomplete results',
  wrong_format: 'Wrong format',
  error: 'Error',
  unclear_docs: 'Unclear docs',
}

/** Replies under their parent, in post order; a reply whose parent is off this page stands on its own. */
export function threadTree(messages: readonly Message[]): { root: Message; replies: Message[] }[] {
  const ids = new Set(messages.map((m) => m.id))
  const roots = messages.filter((m) => m.replyTo === null || !ids.has(m.replyTo))
  return roots.map((root) => ({ root, replies: messages.filter((m) => m.replyTo === root.id) }))
}
