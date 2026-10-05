import 'server-only'

import { adminEnvSchema, loadEnv, type AdminEnv } from '@ryadom/core/config'

let cachedEnv: AdminEnv | undefined

/**
 * Lazily, not at module import: `next build` loads route modules without the container's env.
 * instrumentation.ts validates the same schema at server start.
 */
export function adminEnv(): AdminEnv {
  cachedEnv ??= loadEnv(adminEnvSchema)
  return cachedEnv
}
