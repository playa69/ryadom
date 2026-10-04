import type { Instrumentation } from 'next'

/** Fields the logger removes: one-time codes, session tokens, secrets. */
const LOG_REDACT = [
  'code',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'req.headers.authorization',
  'req.headers.cookie',
]

/**
 * Server start: logger settings before the first record, then env validated by the core schema
 * so a bad configuration kills the process immediately with every error listed, rather than on
 * the first database query.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Image builds run without the container's env, so there is nothing to validate.
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { configureLogger, startTelemetry } = await import('@ryadom/core/shared')
  configureLogger({ redact: LOG_REDACT })
  const { loadEnv, adminEnvSchema } = await import('@ryadom/core/config')
  loadEnv(adminEnvSchema)
  startTelemetry()
}

/** Render and route errors go to the core logger with the digest shown on the error page. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { createLogger } = await import('@ryadom/core/shared')
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error ? String(error.digest) : undefined
  createLogger('admin').error('Request failed', error, {
    digest,
    method: request.method,
    path: request.path,
    routePath: context.routePath,
    routeType: context.routeType,
  })
}
