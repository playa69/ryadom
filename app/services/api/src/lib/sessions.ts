import { randomUUID } from 'node:crypto'
import {
  DeleteExpiredRefreshTokensCommand,
  GetRefreshTokenQuery,
  GetRefreshTokenQueryErrorCode,
  GetSessionStatusQuery,
  ListUserSessionsQuery,
  RevokeRefreshTokenCommand,
  RevokeRefreshTokenCommandErrorCode,
  RevokeSessionRefreshTokensCommand,
  RevokeUserRefreshTokensCommand,
  RevokeUserSessionCommand,
  RevokeUserSessionCommandErrorCode,
  StoreRefreshTokenCommand,
  StoreRefreshTokenCommandErrorCode,
  refreshTokensManager,
  type RefreshTokenDTO,
  type SessionDTO,
} from '@ryadom/core/managers/refresh-tokens-manager'
import { createLogger } from '@ryadom/core/shared'
import assertNever from 'assert-never'
import type { ClientDevice } from './client-device'
import { REFRESH_TTL_SECONDS, type Jwt, type TokenPair } from './jwt'

/**
 * Sessions of the app: refresh tokens that can be rotated and revoked.
 *
 * A session is a chain of refresh tokens, all with one `sid`. Every use of a token retires it and
 * issues the next one, so a copy that leaks is good only until the real client refreshes next. Two
 * cases are told apart when a retired token comes back:
 *
 * - within `REFRESH_GRACE_MS` it is a client that never received the answer (the network dropped
 *   after the server had rotated) or a second tab that refreshed at the same moment. It gets a new
 *   pair, in the same session, and nothing else happens;
 * - later it is a copy somebody kept: every session of the person ends, the real client
 *   included, and the next sign-in is the price of knowing the leak is closed.
 *
 * Only a token retired by rotation is judged this way. One that was signed out or revoked is dead
 * and stays so: a stale tab presenting it is not a theft, and must not sign the person out of their
 * other devices. Signing out and revoking end every token of the session, rotated ones included,
 * otherwise one of those could still be exchanged during the grace window.
 *
 * The access token stays stateless, so a revoked session lives until its access token expires
 * (15 minutes) and not a moment longer than the next refresh. What holds an access token for longer
 * than that, an open dialog, asks `isActive` itself.
 */
export const REFRESH_GRACE_MS = 10_000

/** Tokens that expired before this long ago are no longer needed even to recognise a replay. */
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000

export type RotateOutcome = { ok: true; tokens: TokenPair } | { ok: false; reason: 'invalid' | 'replayed' }

export interface Sessions {
  /** A new session: a token pair whose refresh token is registered. */
  start(userId: string, device: ClientDevice): Promise<TokenPair>
  /** Exchanges a refresh token (already verified by signature) for the next pair of its session. */
  rotate(token: { userId: string; tokenId: string; device: ClientDevice }): Promise<RotateOutcome>
  /** Ends the session of this refresh token. A token that is unknown or already ended is not an error. */
  end(tokenId: string): Promise<void>
  /** The open sessions of a person, the most recently used first. */
  list(userId: string): Promise<SessionDTO[]>
  /** The person ends one of their own sessions. False when none of theirs has this id. */
  endOne(userId: string, sessionId: string): Promise<boolean>
  /** Ends every session of the person, or every one but `exceptSessionId`. */
  endAll(userId: string, exceptSessionId: string | null): Promise<void>
  /** Whether the session is still open. For what outlives an access token, such as a dialog. */
  isActive(sessionId: string): Promise<boolean>
  /** Housekeeping for the registry. */
  purgeExpired(): Promise<void>
}

export function createSessions(jwt: Jwt): Sessions {
  const logger = createLogger('sessions')

  async function find(tokenId: string): Promise<RefreshTokenDTO | null> {
    const result = await refreshTokensManager.execute(new GetRefreshTokenQuery({ tokenId }))
    if (result.success) return result.token
    switch (result.error) {
      case GetRefreshTokenQueryErrorCode.TOKEN_NOT_FOUND:
        return null
      default:
        return assertNever(result.error)
    }
  }

  /** The next token of a session: registered first, so that a signed token always has a row. */
  async function issue(userId: string, sessionId: string, device: ClientDevice): Promise<TokenPair> {
    const tokenId = randomUUID()
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000)
    const stored = await refreshTokensManager.execute(
      new StoreRefreshTokenCommand({ tokenId, sessionId, userId, expiresAt, ...device }),
    )
    if (!stored.success) {
      switch (stored.error) {
        case StoreRefreshTokenCommandErrorCode.TOKEN_ALREADY_EXISTS:
          throw new Error('A random refresh token id collided with a registered one')
        default:
          assertNever(stored.error)
      }
    }
    return jwt.issueTokenPair(userId, { refreshTokenId: tokenId, sessionId })
  }

  return {
    start: (userId, device) => issue(userId, randomUUID(), device),

    async rotate({ userId, tokenId, device }) {
      let token = await find(tokenId)
      if (!token || token.userId !== userId) return { ok: false, reason: 'invalid' }
      const now = new Date()
      if (token.expiresAt <= now) return { ok: false, reason: 'invalid' }

      if (token.revokedAt === null) {
        const retired = await refreshTokensManager.execute(
          new RevokeRefreshTokenCommand({ tokenId, reason: 'rotated', revokedAt: now }),
        )
        if (retired.success) return { ok: true, tokens: await issue(userId, token.sessionId, device) }
        switch (retired.error) {
          case RevokeRefreshTokenCommandErrorCode.TOKEN_NOT_ACTIVE:
            break
          default:
            assertNever(retired.error)
        }
        // Another request with the same token retired it between our read and our write: judge it
        // the way a request that came a moment later would.
        token = await find(tokenId)
        if (!token || token.revokedAt === null) return { ok: false, reason: 'invalid' }
      }

      if (token.revokedReason !== 'rotated') return { ok: false, reason: 'invalid' }
      if (now.getTime() - token.revokedAt.getTime() <= REFRESH_GRACE_MS) {
        return { ok: true, tokens: await issue(userId, token.sessionId, device) }
      }

      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({ userId, exceptSessionId: null, revokedAt: now }),
      )
      logger.warn(
        'A rotated refresh token came back after the grace window: every session of the user is revoked',
        undefined,
        { userId, tokenId, sessionId: token.sessionId },
      )
      return { ok: false, reason: 'replayed' }
    },

    async end(tokenId) {
      const token = await find(tokenId)
      if (!token) return
      await refreshTokensManager.execute(
        new RevokeSessionRefreshTokensCommand({ sessionId: token.sessionId, revokedAt: new Date() }),
      )
    },

    async list(userId) {
      const result = await refreshTokensManager.execute(
        new ListUserSessionsQuery({ userId, now: new Date() }),
      )
      return result.sessions
    },

    async endOne(userId, sessionId) {
      const result = await refreshTokensManager.execute(
        new RevokeUserSessionCommand({ userId, sessionId, revokedAt: new Date() }),
      )
      if (result.success) return true
      switch (result.error) {
        case RevokeUserSessionCommandErrorCode.SESSION_NOT_FOUND:
          return false
        default:
          return assertNever(result.error)
      }
    },

    async endAll(userId, exceptSessionId) {
      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({ userId, exceptSessionId, revokedAt: new Date() }),
      )
    },

    async isActive(sessionId) {
      const result = await refreshTokensManager.execute(new GetSessionStatusQuery({ sessionId }))
      return result.active
    },

    async purgeExpired() {
      await refreshTokensManager.execute(
        new DeleteExpiredRefreshTokensCommand({ before: new Date(Date.now() - PURGE_AFTER_MS) }),
      )
    },
  }
}
