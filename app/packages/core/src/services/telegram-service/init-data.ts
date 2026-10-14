import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Telegram Mini App launch data (`Telegram.WebApp.initData`): a query string Telegram builds when the
 * Mini App opens, with the person's Telegram user and `auth_date`, signed with a key derived from the
 * bot's token (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Pure functions, so the rules can be tested without a server.
 */

/** The Telegram user the launch data is about. Only what sign-in needs is kept. */
export interface TelegramInitDataUser {
  id: number
  /** Shown back to the person as a suggestion for how the agent should call them; never stored by itself. */
  firstName: string
}

export type InitDataCheck =
  | { ok: true; user: TelegramInitDataUser; authDate: Date }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

/** Launch data longer than this is not something Telegram made. */
const MAX_INIT_DATA_LENGTH = 8192
/** A clock a little ahead of ours is not a forgery; one far ahead is. */
const FUTURE_TOLERANCE_SEC = 300

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function sameHex(expected: Buffer, hex: string): boolean {
  const actual = Buffer.from(hex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Whether the launch data was signed for this bot, is recent enough, and names a Telegram user.
 *
 * The signed text is every field but `hash`, as `key=value` lines sorted by key. Telegram added a
 * `signature` field (Bot API 8.0) that some clients send and some do not, and sources disagree on
 * whether it belongs in the signed text; both readings are accepted, since each needs the bot's key.
 */
export function checkInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number,
  now: Date = new Date(),
): InitDataCheck {
  if (initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH)
    return { ok: false, reason: 'malformed' }
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'malformed' }

  const fields = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const signedText = (entries: [string, string][]) =>
    entries.map(([key, value]) => `${key}=${value}`).join('\n')
  const secretKey = hmac('WebAppData', botToken)
  const signed =
    sameHex(hmac(secretKey, signedText(fields)), hash) ||
    (params.has('signature') &&
      sameHex(hmac(secretKey, signedText(fields.filter(([key]) => key !== 'signature'))), hash))
  if (!signed) return { ok: false, reason: 'bad_signature' }

  const authDateSec = Number(params.get('auth_date'))
  if (!Number.isSafeInteger(authDateSec) || authDateSec <= 0) return { ok: false, reason: 'malformed' }
  const ageSec = now.getTime() / 1000 - authDateSec
  if (ageSec < -FUTURE_TOLERANCE_SEC) return { ok: false, reason: 'malformed' }
  if (ageSec > maxAgeSec) return { ok: false, reason: 'expired' }

  let user: unknown
  try {
    user = JSON.parse(params.get('user') ?? '')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const { id, first_name: firstName } = (user ?? {}) as { id?: unknown; first_name?: unknown }
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    return { ok: false, reason: 'malformed' }
  return {
    ok: true,
    user: { id, firstName: typeof firstName === 'string' ? firstName : '' },
    authDate: new Date(authDateSec * 1000),
  }
}

/**
 * Launch data signed the way Telegram signs it. For tests and local tools: with the real bot token it
 * makes a valid sign-in for anyone, so it must never be reachable from a route.
 */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const entries = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const hash = hmac(hmac('WebAppData', botToken), entries.map(([key, value]) => `${key}=${value}`).join('\n'))
  const params = new URLSearchParams(entries)
  params.set('hash', hash.toString('hex'))
  return params.toString()
}
