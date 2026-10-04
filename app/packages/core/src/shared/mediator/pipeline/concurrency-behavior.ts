import { pipelineBehavior, type PipelineBehavior, type RequestData } from 'mediatr-ts'
import { ConcurrencyError } from '../../errors'

/** Retries the request on ConcurrencyError (optimistic locking) with an exponential backoff. */
@pipelineBehavior()
export class ConcurrencyBehavior implements PipelineBehavior {
  private readonly maxRetries = 3
  private readonly retryDelayMs = 50

  async handle(_request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await next()
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || attempt >= this.maxRetries) throw error
        const delay = this.retryDelayMs * 2 ** (attempt - 1) + Math.random() * 25
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
}
