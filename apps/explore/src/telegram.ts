import { boardKey, viewerKey } from './queries.ts'
import { currentBoardId } from './api.ts'
import { useQuery } from '@tanstack/react-query'
import { tool } from './api.ts'

/** Sidequest's bot. Its `/start <code>` finishes a link the wallet has signed for. */
declare const __SIDEQUEST_TELEGRAM_BOT__: string
export const TELEGRAM_BOT =
  typeof __SIDEQUEST_TELEGRAM_BOT__ === 'string' ? __SIDEQUEST_TELEGRAM_BOT__ : 'sidequest_excange_dev_bot'

/** What the bot DMs about once linked (B9). */
export const TELEGRAM_NOTICES = [
  'A delivery is submitted on your job',
  'A day before your silence approves a delivery',
  'You are hired or selected',
  'A dispute is ruled',
  'Something is ready to collect',
] as const

export interface TelegramStatus {
  linked: boolean
  /** The Telegram username, when the chat has one. */
  username: string | null
  linkedAt: number | null
}

/** A one-time link code, and the text the wallet signs to claim it. */
export interface TelegramLinkPrep {
  nonce: string
  message: string
  expiresAt: number
}

/**
 * The bot's deep link for a code, or null when the code is not one Telegram passes to `/start` (1–64 of
 * `A-Z a-z 0-9 _ -`): better no link than one that opens the bot without the code.
 */
export function deepLink(nonce: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(nonce) ? `https://t.me/${TELEGRAM_BOT}?start=${nonce}` : null
}

/** Before signing: the board's text must name this wallet and this code, so a signature cannot link anything else. */
export function linkMessageProblem(prep: TelegramLinkPrep, wallet: string): string | null {
  const text = prep.message.toLowerCase()
  if (!text.includes(wallet.toLowerCase())) return 'The text to sign does not name your wallet. Nothing was signed.'
  if (!prep.message.includes(prep.nonce)) return 'The text to sign does not carry the link code. Nothing was signed.'
  if (deepLink(prep.nonce) === null) return 'The link code is not one Telegram accepts. Nothing was signed.'
  return null
}

const key = (wallet: string) => `sidequest.telegram-link:${wallet.toLowerCase()}`

/** A code waiting for the bot, kept across the trip to Telegram and back (mobile reloads the PWA). */
export const pendingLink = {
  load(wallet: string): { nonce: string; expiresAt: number } | null {
    try {
      const v = JSON.parse(localStorage.getItem(key(wallet)) ?? 'null') as {
        nonce?: unknown
        expiresAt?: unknown
      } | null
      return v !== null && typeof v.nonce === 'string' && typeof v.expiresAt === 'number'
        ? { nonce: v.nonce, expiresAt: v.expiresAt }
        : null
    } catch {
      return null
    }
  },
  save(wallet: string, v: { nonce: string; expiresAt: number }) {
    localStorage.setItem(key(wallet), JSON.stringify(v))
  },
  clear(wallet: string) {
    localStorage.removeItem(key(wallet))
  },
}

/** Whether this wallet is linked; polled while a code waits for the bot. */
export function useTelegramStatus(wallet: string | undefined, signedIn: boolean, waiting: boolean) {
  return useQuery({
    queryKey: boardKey(currentBoardId(), 'telegram_status', viewerKey(wallet, signedIn)),
    queryFn: () => tool<TelegramStatus>('telegram_status', { wallet }),
    enabled: wallet !== undefined && signedIn,
    refetchInterval: waiting ? 3_000 : false,
    retry: false,
  })
}

export const telegramApi = {
  prepare: (wallet: string) => tool<TelegramLinkPrep>('telegram_link_prepare', { wallet }),
  confirm: (nonce: string, signature: string) => tool<{ ok: true }>('telegram_link_confirm', { nonce, signature }),
  unlink: (wallet: string) => tool<{ ok: true }>('telegram_unlink', { wallet }),
}
