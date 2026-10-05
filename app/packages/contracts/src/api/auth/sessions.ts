/**
 * The person's own sessions: every browser or phone they are signed in on.
 *
 * `GET /api/auth/sessions` lists the open ones, the most recently used first, with the one that asks
 * marked `current`. `DELETE /api/auth/sessions/:id` ends one of them (the current one included, which
 * is a sign-out). What a session is told about the device is what the client said about itself in
 * `x-client-id` and `User-Agent`; there is no address or place, so it is a label for recognising a
 * device and not a proof of what it is.
 *
 * A session ended here stops being able to refresh at once; its access token, already issued, lives
 * out its 15 minutes, and a dialog open on it is closed within the gateway's next session check.
 */

/** Which of our clients the session belongs to. */
export enum SessionClient {
  Web = 'web',
  /** The installed PWA. */
  Pwa = 'pwa',
  Android = 'android',
  Ios = 'ios',
}

export interface SessionApiResponse {
  /** The id to end the session by. It is not a token and grants nothing. */
  id: string
  /** The session of this very request. */
  current: boolean
  /** Null when the client said nothing, or something that is not one of ours. */
  client: SessionClient | null
  /** Names read from `User-Agent`, such as `Chrome` and `Windows`; null when they could not be told. */
  browser: string | null
  os: string | null
  /** ISO 8601: when the person signed in. */
  startedAt: string
  /** ISO 8601: the latest refresh, so at most 15 minutes behind the person's last request. */
  lastUsedAt: string
}

export interface ListSessionsApiResponse {
  sessions: SessionApiResponse[]
}

export enum EndSessionApiErrorCode {
  /** No open session with this id is the person's: it was ended already, or it never was theirs. */
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
}
