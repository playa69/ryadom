/**
 * Keeps the agent's frames in the agent's order on their way to the client while some of them are
 * still being prepared off the main thread (Opus speech). `tts_end` must not overtake the last audio,
 * and the next reply's text must not overtake the speech before it.
 *
 * A value that is ready while nothing waits ahead of it is delivered at once, in the same tick: text,
 * PCM16 and μ-law never wait here. Only behind a pending value does the rest queue up.
 */
export class InOrder {
  private tail: Promise<void> = Promise.resolve()
  private waiting = 0
  private stopped = false

  /** `onError`: a pending value failed (the encoder died); it is skipped and the rest go on. */
  constructor(private readonly onError: (error: unknown) => void) {}

  push<T>(value: T | Promise<T>, deliver: (value: T) => void): void {
    if (this.stopped) return
    if (this.waiting === 0 && !(value instanceof Promise)) {
      deliver(value)
      return
    }
    this.waiting += 1
    // A value that fails while a slower one ahead of it is still awaited has no handler yet; the chain
    // below reports the failure, this only keeps it from counting as unhandled in the meantime.
    if (value instanceof Promise) value.catch(() => {})
    this.tail = this.tail
      .then(() => value)
      .then((ready) => {
        if (!this.stopped) deliver(ready)
      })
      .catch((error: unknown) => {
        if (!this.stopped) this.onError(error)
      })
      .finally(() => {
        this.waiting -= 1
      })
  }

  /** The connection is gone: nothing more is delivered, and what still waits is dropped. */
  stop(): void {
    this.stopped = true
  }
}
