/** Optimistic locking conflict: ConcurrencyBehavior retries the request. */
export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConcurrencyError'
  }
}

/** Invalid input to a core operation: a bug in the calling code, not a domain rejection. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * The dialog agent did not answer: network, timeout, 5xx, or an unparsable response. This is a
 * technical failure, not a domain rejection (by the core rules it is thrown rather than returned
 * as a code), but the application has to tell it apart from its own errors: it answers 503 and
 * shows the help lines instead of a generic failure message. A separate class is the
 * only way to distinguish it.
 */
export class AgentUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'AgentUnavailableError'
  }
}
