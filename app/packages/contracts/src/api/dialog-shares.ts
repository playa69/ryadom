/**
 * A link to one conversation (`REQ-DATA-05`). The owner has at most one active link per dialog and
 * can always read it again; whoever holds the link reads the conversation up to the moment it was
 * made, without signing in. Adds routes and fields only.
 */

/** How long a link may live, in hours: 24 hours, 3 days, 7 days. The first is the default. */
export const DIALOG_SHARE_TTL_HOURS = [24, 72, 168] as const
export type DialogShareTtlHours = (typeof DIALOG_SHARE_TTL_HOURS)[number]
export const DIALOG_SHARE_DEFAULT_TTL_HOURS: DialogShareTtlHours = 24

/** Active links one account may hold at once. */
export const DIALOG_SHARE_MAX_ACTIVE = 5

export enum DialogShareApiErrorCode {
  /** The dialog already has an active link: read it with `GET`. */
  SHARE_EXISTS = 'SHARE_EXISTS',
  /** The account holds as many active links as it may. */
  SHARE_LIMIT = 'SHARE_LIMIT',
  /** Links are switched off on the server. */
  SHARE_DISABLED = 'SHARE_DISABLED',
}

export interface CreateDialogShareApiRequest {
  ttlHours?: DialogShareTtlHours
}

/** The owner's view of the link. The `url` carries the token: it is the secret, never log it. */
export interface DialogShareApiResponse {
  shareId: string
  url: string
  createdAt: string
  expiresAt: string
  viewCount: number
  lastViewedAt: string | null
}

export interface SharedDialogMessageApiResponse {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

/** What whoever opens the link sees: no summary, no tension, no identifiers, no audio. */
export interface SharedDialogApiResponse {
  startedAt: string
  /** The moment the link was made: the conversation is shown up to it. */
  sharedAt: string
  expiresAt: string
  /** The conversation was still going when it was shared. */
  isOpen: boolean
  messages: SharedDialogMessageApiResponse[]
}
