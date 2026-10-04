/**
 * Errors and their phrases. The server answers with an envelope, which the client splits into two
 * outcomes:
 *
 * - 200 with `{ status: false, errorCode }` means the route named the rule that was broken. Such
 *   functions return `ApiOutcome`, and the code is typed by the contract, so the screen has to
 *   supply a phrase for every one of them (`codeText`).
 * - Any non-200, a dropped connection included, is a generic failure: an `ApiError` carrying the
 *   status is thrown. The screen catches it in a single catch and shows a generic phrase
 *   (`apiErrorText`).
 */

/** Status for a failure before any server response: no network, or a dropped connection. */
export const NETWORK_ERROR_STATUS = 0

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}`)
    this.name = 'ApiError'
  }
}

export type ApiOutcome<T, C extends string> = { ok: true; data: T } | { ok: false; code: C }

export interface ApiErrorTexts {
  /** Overrides the generic phrase per status, where the screen knows what that status means. */
  byStatus?: Partial<Record<number, string>>
}

export const NETWORK_ERROR_TEXT = 'Нет связи с сервером. Проверь интернет и попробуй ещё раз'
export const SERVER_ERROR_TEXT = 'Что-то пошло не так на нашей стороне. Попробуй чуть позже'
export const AGENT_ERROR_TEXT = 'Сейчас я не могу ответить. Если тяжело — линии помощи ниже'

/** Phrase for a catch block: generic, refined per status when the screen knows the status. */
export function apiErrorText(error: unknown, texts: ApiErrorTexts, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback
  const byStatus = texts.byStatus?.[error.status]
  if (byStatus) return byStatus
  if (error.status === NETWORK_ERROR_STATUS) return NETWORK_ERROR_TEXT
  if (error.status === 429) return 'Слишком часто. Подожди немного и попробуй снова'
  if (error.status === 503) return AGENT_ERROR_TEXT
  if (error.status >= 500) return SERVER_ERROR_TEXT
  return fallback
}

/**
 * Phrase for an outcome code. The dictionary is declared as `Record<XxxApiErrorCode, string>`, so
 * a new code in the contract will not compile without a phrase. `fallback` covers a code this
 * client does not know yet, when the server is newer than it.
 */
export function codeText<C extends string>(texts: Record<C, string>, code: C, fallback: string): string {
  return (texts as Record<string, string>)[code] ?? fallback
}
