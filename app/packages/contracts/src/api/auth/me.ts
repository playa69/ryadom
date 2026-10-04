/**
 * The current user's profile:
 *
 * - `GET /api/auth/me` — the profile for the profile screen;
 * - `PATCH /api/auth/me` `{ name }` — change the name (422 when empty or longer than
 *   `InputLimit.NameMax`);
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
  /** ISO 8601 registration date. */
  createdAt: string
  /** The person has agreed to everything a conversation needs (`POST /api/auth/me/consents`). */
  consentsCompleted: boolean
  /** The newest version of the terms they accepted; null before the first acceptance. */
  consentVersion: string | null
}

export interface UpdateMeApiRequest {
  name: string
}

export enum MeApiErrorCode {
  /** The account is gone: deleted between requests. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}
