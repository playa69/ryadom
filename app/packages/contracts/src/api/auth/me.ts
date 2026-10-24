/**
 * The current user's profile:
 *
 * - `GET /api/auth/me` — the profile for the profile screen;
 * - `PATCH /api/auth/me` `{ name?, voice?, analyticsOptOut?, timezone? }` — change the name (422 when empty or
 *   longer than `InputLimit.NameMax`), the voice the agent speaks with (400 for a value other than
 *   `AgentVoice`) and/or whether product analytics are off for the account; at least one field is
 *   required (422 for an empty body);
 * - `DELETE /api/auth/me` — "erase everything": the data held by the agent and the account itself
 *. The response is `null`, and a repeat is also a success. If the agent is
 *   unavailable it is a 503, because the promise "we erased everything" was not kept.
 */
export interface MeApiResponse {
  id: string
  /** null for an anonymous account that has not linked an address (`POST /api/auth/email/link`). */
  email: string | null
  name: string | null
  isEmailConfirmed: boolean
  /** A Telegram user is linked (`POST /api/auth/telegram`, `POST /api/auth/telegram/link`). */
  telegramLinked: boolean
  /** ISO 8601 registration date. */
  createdAt: string
  /** The person has agreed to everything a conversation needs (`POST /api/auth/me/consents`). */
  consentsCompleted: boolean
  /** The newest version of the terms they accepted; null before the first acceptance. */
  consentVersion: string | null
  /** The voice the agent speaks with. Applies from the next conversation start. */
  voice: AgentVoice
  /**
   * The person turned product analytics off for their account. The server then reports nothing about
   * them, on any device; the clients follow it (and tell the account about a "no" said before sign-in).
   */
  analyticsOptOut: boolean
  /** The mood diary is switched on on this server (`DIARY_ENABLED`): without it the clients show no diary section. */
  diaryEnabled: boolean
  /** IANA time zone of the person; the diary day, the reminder and the weekly summary follow it. */
  timezone: string
}

/** The agent's voice by gender. The agent maps it to the voice of its speech provider. */
export const AGENT_VOICES = ['male', 'female'] as const
export type AgentVoice = (typeof AGENT_VOICES)[number]
/** What a new account gets until the person picks another voice. */
export const DEFAULT_AGENT_VOICE: AgentVoice = 'male'

export interface UpdateMeApiRequest {
  name?: string
  voice?: AgentVoice
  analyticsOptOut?: boolean
  /** IANA name (`Europe/Moscow`); 422 for a name the server does not know. */
  timezone?: string
}

/** The zone an account has until a client reports the person's own. */
export const DEFAULT_TIMEZONE = 'Europe/Moscow'

export enum MeApiErrorCode {
  /** The account is gone: deleted between requests. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}
