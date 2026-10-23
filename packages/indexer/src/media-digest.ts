/**
 * The media team's morning digest (ADR-0029): one Telegram message a day to each team wallet with a linked chat, on the
 * first cron run between 08:00 and 11:00 in the stage's media timezone that has not sent it. It names today's approved
 * posts, the drafts waiting for approval and what agents published or approved since yesterday. The outbox id
 * `media-digest:<day>:<wallet>` makes it once a day however often the cron runs; it is a reminder, never the record.
 */
import type { Network } from '@sidequest/sdk'
import { stageProfile, type StageMedia } from '../../../infra/stage.ts'
import { migrateMedia } from './media-schema.ts'
import type { AsyncSql } from './store.ts'
import { enqueueWalletNotification, publicOrigin } from './telegram.ts'

/** The media team of a deployed stage; none locally. */
export const stageMediaOf = (stage: unknown): StageMedia | undefined =>
  stage === 'dev' || stage === 'prod' ? stageProfile(stage)?.media : undefined

/** A moment's local day (YYYY-MM-DD), hour and long date in a zone, daylight saving included. */
export function localDay(now: number, timeZone: string): { day: string; hour: number; label: string } {
  const at = new Date(now * 1000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  const label = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(
    at,
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), label }
}

const FIRST_HOUR = 8
const LAST_HOUR = 11

const ACTIONS: Readonly<Record<string, string>> = {
  'asset.publish': 'published',
  'asset.unpublish': 'unpublished',
  'post.approve': 'approved the post',
}

const line = (post: { time: string | null; channel: string; account: string | null; text: string }) =>
  `${post.time ?? 'any time'}, ${post.channel}${post.account === null ? '' : ` ${post.account}`}: ${post.text.replace(/\s+/g, ' ').slice(0, 90)}`

/** The digest for one day, or undefined when there is nothing to say. */
export async function mediaDigestText(
  sql: AsyncSql,
  day: string,
  label: string,
  since: number,
): Promise<string | undefined> {
  const today = await sql.all<{ time: string | null; channel: string; account: string | null; text: string }>(
    "SELECT time, channel, account, text FROM media_posts WHERE day = ? AND status = 'approved' ORDER BY COALESCE(time, ''), id LIMIT 10",
    day,
  )
  const [waiting] = await sql.all<{ n: number }>(
    "SELECT COUNT(*) n FROM media_posts WHERE status = 'draft' AND (day IS NULL OR day >= ?)",
    day,
  )
  const agents = await sql.all<{ action: string; target: string }>(
    "SELECT action, target FROM media_log WHERE actor_kind = 'agent' AND at > ? AND action IN ('asset.publish', 'asset.unpublish', 'post.approve') ORDER BY at LIMIT 10",
    since,
  )
  const drafts = waiting?.n ?? 0
  if (today.length === 0 && drafts === 0 && agents.length === 0) return undefined
  return [
    `Sidequest media, ${label}`,
    ...(today.length === 0
      ? ['Nothing approved to post today.']
      : [`To post today (${today.length}):`, ...today.map(line)]),
    ...(drafts === 0 ? [] : [`Waiting for approval: ${drafts} ${drafts === 1 ? 'draft' : 'drafts'}.`]),
    ...(agents.length === 0
      ? []
      : [
          'Agents since yesterday:',
          ...agents.map((entry) => `${ACTIONS[entry.action] ?? entry.action} ${entry.target}`),
        ]),
    `The plan: ${publicOrigin()}/media/internal?tab=plan`,
  ].join('\n')
}

/** Queues today's digest for every team wallet not yet sent one; answers how many were queued. */
export async function queueMediaDigest(
  sql: AsyncSql,
  network: Network,
  media: StageMedia,
  now: number,
): Promise<number> {
  const { day, hour, label } = localDay(now, media.timezone)
  if (hour < FIRST_HOUR || hour >= LAST_HOUR || media.team.length === 0) return 0
  const ids = new Map(media.team.map((member) => [`media-digest:${day}:${member.wallet.toLowerCase()}`, member.wallet]))
  const sent = new Set(
    (
      await sql.all<{ id: string }>(
        `SELECT id FROM telegram_outbox WHERE id IN (${[...ids.keys()].map(() => '?').join(', ')})`,
        ...ids.keys(),
      )
    ).map((row) => row.id),
  )
  const due = [...ids].filter(([id]) => !sent.has(id))
  if (due.length === 0) return 0
  await migrateMedia(sql)
  const text = await mediaDigestText(sql, day, label, now - 86_400)
  if (text === undefined) return 0
  for (const [id, wallet] of due) await enqueueWalletNotification(sql, network, wallet, { id, text, now })
  return due.length
}
