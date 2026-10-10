import {
  BadgeCheck,
  BriefcaseBusiness,
  CircleSlash,
  CircleX,
  Coins,
  Handshake,
  type LucideIcon,
  Megaphone,
  MessageSquareQuote,
  PackageCheck,
  Scale,
  ShieldCheck,
  UserPlus,
} from 'lucide-react'

/**
 * The icon for an event kind (`job.submitted`, `quote.received`…), shared by the Live strip on Jobs and the account's
 * own activity. Exact kinds first, then the family; anything new falls back to a job.
 */
const BY_KIND: Readonly<Record<string, LucideIcon>> = {
  'job.published': Megaphone,
  'job.activated': Handshake,
  'job.submitted': PackageCheck,
  'job.completed': BadgeCheck,
  'job.rejected': CircleX,
  'job.closed': CircleX,
  'job.disputed': Scale,
  'job.ruled': Scale,
  'job.expired': CircleSlash,
  'job.cancelled': CircleSlash,
  'request.opened': Megaphone,
  'request.picked': Handshake,
  'quote.lost': CircleX,
}
const BY_FAMILY: Readonly<Record<string, LucideIcon>> = {
  payout: Coins,
  settlement: Coins,
  quote: MessageSquareQuote,
  application: UserPlus,
  selection: UserPlus,
  invite: UserPlus,
  approval: ShieldCheck,
  permission: ShieldCheck,
}

export function activityIcon(kind: string): LucideIcon {
  return BY_KIND[kind] ?? BY_FAMILY[kind.split('.')[0] ?? ''] ?? BriefcaseBusiness
}

/** An event's link as a path on this origin when it points here, so it opens in the app; other links are kept. */
export function localHref(url: string | undefined, origin: string): string | undefined {
  if (url === undefined || url === '') return undefined
  try {
    const u = new URL(url, origin)
    return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : u.href
  } catch {
    return undefined
  }
}
