import { getEnv } from '../../config'

/** RuStore Push settings. Read on every request because tests stub env. */
export const ruStorePushConfig = {
  get baseUrl(): string {
    return getEnv().RUSTORE_PUSH_API_URL
  },
  /** The service token of a push project, or null when the server holds none for it. */
  serviceToken(projectId: string): string | null {
    const tokens = getEnv().RUSTORE_PUSH_SERVICE_TOKENS
    return Object.hasOwn(tokens, projectId) ? (tokens[projectId] ?? null) : null
  },
  /** A notification is a side effect of whatever sends it: a push service that hangs must not hold that up. */
  timeoutMs: 10_000,
  /**
   * How long RuStore keeps a message for a phone that is off (its default is four weeks). A phone switched on next week
   * must not show what was said today.
   */
  ttlSeconds: 24 * 60 * 60,
}
