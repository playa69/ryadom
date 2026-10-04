import type { AuthUser } from './auth-guard'
import type { AppServerEnv } from './env'
import type { Jwt } from './jwt'
import type { Logger } from './logger'
import type { PolicySource } from './release-policy'
import type { RateLimiter } from './rate-limit'
import type { Sessions } from './sessions'

/** Hono context types for the whole application. */
export interface AppEnv {
  Variables: {
    /** Present only behind `requireAuth`. */
    auth: AuthUser | undefined
  }
}

/** Application dependencies: passed to `createApp` and substituted in tests. */
export interface AppDeps {
  env: AppServerEnv
  logger: Logger
  policy: PolicySource
  rateLimiter: RateLimiter
}

/** Route dependencies: the same plus JWT keyed by `MOBILE_JWT_SECRET` and the sessions built on it. */
export interface RouteDeps extends AppDeps {
  jwt: Jwt
  sessions: Sessions
}
