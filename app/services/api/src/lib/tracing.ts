import type { MiddlewareHandler } from 'hono'
import { readTracingContext, runWithRequestContext } from '@ryadom/core/shared'
import type { AppEnv } from './context'

/**
 * The outermost middleware: the tracing headers are read once here, and everything below it (the
 * request log, the routes, the calls to the agent) sees them through the request context. The API
 * makes up no trace id: a client that sends none gets none in the logs.
 */
export function tracing(): MiddlewareHandler<AppEnv> {
  return (c, next) =>
    runWithRequestContext(
      readTracingContext((name) => c.req.header(name)),
      next,
    )
}
