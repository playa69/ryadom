import { SignJWT, jwtVerify } from 'jose'

/**
 * Application tokens: jose, HS256, a single `MOBILE_JWT_SECRET` key, and the kind of
 * token in the `type` claim.
 *
 * - access lives 15 minutes, `sub` is the user. Only the signature is verified (auth-guard.ts),
 *   with no database query: account state is checked by `/api/auth/refresh` alone;
 * - refresh lives 30 days and is not rotated.
 *
 * `exp` is in seconds, while `expiresAt` in API responses is in milliseconds.
 */

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

export type TokenType = 'access' | 'refresh'

export interface TokenPayload {
  sub: string
  type: TokenType
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  /** Unix time in milliseconds when the access token expires. */
  expiresAt: number
}

export interface Jwt {
  signAccessToken(userId: string): Promise<string>
  signRefreshToken(userId: string): Promise<string>
  issueTokenPair(userId: string): Promise<TokenPair>
  /** null means a wrong signature, an expired token, the wrong type or a missing `sub`. */
  verifyToken(token: string, expectedType: TokenType): Promise<TokenPayload | null>
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export function createJwt(secret: string): Jwt {
  const key = new TextEncoder().encode(secret)

  const sign = (claims: Record<string, string>, ttlSeconds: number, subject: string): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setSubject(subject)
      .setExpirationTime(nowSeconds() + ttlSeconds)
      .sign(key)

  const signAccessToken = (userId: string) => sign({ type: 'access' }, ACCESS_TTL_SECONDS, userId)
  const signRefreshToken = (userId: string) => sign({ type: 'refresh' }, REFRESH_TTL_SECONDS, userId)

  return {
    signAccessToken,
    signRefreshToken,

    async issueTokenPair(userId) {
      const [accessToken, refreshToken] = await Promise.all([signAccessToken(userId), signRefreshToken(userId)])
      return { accessToken, refreshToken, expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000 }
    },

    async verifyToken(token, expectedType) {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
        if (payload.type !== expectedType) return null
        if (typeof payload.sub !== 'string' || !payload.sub) return null
        return { sub: payload.sub, type: expectedType }
      } catch {
        return null
      }
    },
  }
}
