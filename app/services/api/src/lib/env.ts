import { appEnvSchema, EnvValidationError, loadEnv, type AppEnv as AppServerEnv } from '@ryadom/core/config'

/**
 * Application environment variables, described by the core's `appEnvSchema`.
 *
 * The server validates them at startup and exits with the full list of problems instead of
 * failing on the first request. The core reads the same variables from process.env itself. The
 * template for local development is `.env.example`. An empty string means "not set".
 */

export type { AppServerEnv }
export { EnvValidationError }

export function parseEnv(source: Record<string, string | undefined>): AppServerEnv {
  return loadEnv(appEnvSchema, source)
}
