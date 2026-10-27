import { pipelineBehavior, type PipelineBehavior, type RequestData } from 'mediatr-ts'
import { createLogger, isDebugEnabled } from '../../logger'
import { maskPIIRecursively } from '../../pii-protection'

const LOGGED = Symbol.for('ryadom.core.logged')

/** Marks an error as logged so nested requests do not write it several times. */
function markLogged(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as Record<symbol, unknown>)[LOGGED]) return true
  Object.defineProperty(error, LOGGED, { value: true, enumerable: false })
  return false
}

/**
 * Request name for the logs: `constructor.name` is minified in the production web build (Turbopack
 * renames classes), so every contract declares `static readonly requestName`, a string literal the
 * minifier leaves alone (AGENTS.md).
 */
function requestName(request: RequestData<unknown>): string {
  const declared = (request.constructor as { requestName?: unknown }).requestName
  return typeof declared === 'string' ? declared : request.constructor.name
}

@pipelineBehavior()
export class LoggingBehavior implements PipelineBehavior {
  async handle(request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    const logger = createLogger('mediator')
    const name = requestName(request)
    const started = performance.now()
    if (isDebugEnabled()) logger.debug(`${name} started`, { request: maskPIIRecursively(request) })
    try {
      const result = await next()
      if (isDebugEnabled()) {
        logger.debug(`${name} completed`, { durationMs: Math.round(performance.now() - started) })
      }
      return result
    } catch (error) {
      if (!markLogged(error)) {
        logger.error(`${name} failed`, error, {
          durationMs: Math.round(performance.now() - started),
          request: maskPIIRecursively(request),
        })
      }
      throw error
    }
  }
}
