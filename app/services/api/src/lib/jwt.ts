import { randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

/**
 * Application tokens: jose, HS256, a single `MOBILE_JWT_SECRET` key, and the kind of
 * token in the `type` claim.
 *
 * - access lives 15 minutes, `sub` is the user. Only the signature is verified (auth-guard.ts),
 *   with no database query: account state is checked by `/api/auth/refresh` alone;
 * - refresh lives 30 days and carries a `jti`, the id under which `sessions.ts` registers it, so
 *   that a refresh token can be rotated and revoked. The signature alone proves nothing about a
 *   refresh token: whether it is still alive is the registry's word.
 *
 * Both carry `sid`, the id of the session. It stays the same through every rotation, so a request
 * can say which session it comes from (the one that changes a password keeps working) without
 * knowing which of the session's refresh tokens is the current one.
 *
 * `exp` is in seconds, while `expiresAt` in API responses is in milliseconds.
 */

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

export type TokenType = 'access' | 'refresh'

export interface TokenPayload {
  sub: string
  type: TokenType
  /** Only refresh tokens carry one. */
  jti?: string
  /** Absent from tokens issued before sessions existed. */
  sid?: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  /** Unix time in milliseconds when the access token expires. */
  expiresAt: number
}

export interface TokenIds {
  /** What the registry knows the refresh token by. */
  refreshTokenId?: string
  sessionId?: string
}

export interface Jwt {
  signAccessToken(userId: string, sessionId?: string): Promise<string>
  signRefreshToken(userId: string, tokenId: string, sessionId: string): Promise<string>
  /** Fresh ids are made up for whatever `ids` leaves out. */
  issueTokenPair(userId: string, ids?: TokenIds): Promise<TokenPair>
  /** null means a wrong signature, an expired token, the wrong type or a missing `sub`. */
  verifyToken(token: string, expectedType: TokenType): Promise<TokenPayload | null>
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export function createJwt(secret: string): Jwt {
  const key = new TextEncoder().encode(secret)

  const sign = (
    claims: Record<string, string>,
    ttlSeconds: number,
    subject: string,
    tokenId?: string,
  ): Promise<string> => {
    const token = new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setSubject(subject)
      .setExpirationTime(nowSeconds() + ttlSeconds)
    if (tokenId) token.setJti(tokenId)
    return token.sign(key)
  }

  const signAccessToken = (userId: string, sessionId?: string) =>
    sign({ type: 'access', ...(sessionId ? { sid: sessionId } : {}) }, ACCESS_TTL_SECONDS, userId)
  const signRefreshToken = (userId: string, tokenId: string, sessionId: string) =>
    sign({ type: 'refresh', sid: sessionId }, REFRESH_TTL_SECONDS, userId, tokenId)

  return {
    signAccessToken,
    signRefreshToken,

    async issueTokenPair(userId, ids = {}) {
      const sessionId = ids.sessionId ?? randomUUID()
      const [accessToken, refreshToken] = await Promise.all([
        signAccessToken(userId, sessionId),
        signRefreshToken(userId, ids.refreshTokenId ?? randomUUID(), sessionId),
      ])
      return { accessToken, refreshToken, expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000 }
    },

    async verifyToken(token, expectedType) {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
        if (payload.type !== expectedType) return null
        if (typeof payload.sub !== 'string' || !payload.sub) return null
        return {
          sub: payload.sub,
          type: expectedType,
          ...(typeof payload.jti === 'string' ? { jti: payload.jti } : {}),
          ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
        }
      } catch {
        return null
      }
    },
  }
}
