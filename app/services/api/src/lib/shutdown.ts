/**
 * The order in which a pod stops. A pod cannot just vanish: the balancer learns about
 * it with a delay, and thousands of dialogs closed in one instant would return in one second. So, in
 * order:
 *
 *  1. draining: the health check answers 503 and a new dialog socket is turned away, so the balancer
 *     takes the pod out of rotation (`DRAIN_MS`);
 *  2. every open dialog gets code 1012 and the clients reconnect on their own, to the pods that stay;
 *     the closing is spread over `CLOSE_SPREAD_MS`;
 *  3. in-flight requests finish, the pool closes, and the process exits at `HARD_EXIT_MS` at the latest.
 *
 * The whole run fits in `terminationGracePeriodSeconds` of 15. Ctrl+C in development (SIGINT) skips
 * the waiting. The steps are passed in, so the timeline can be tested without a real signal.
 */
export const DRAIN_MS = 4_000
export const CLOSE_SPREAD_MS = 5_000
export const HARD_EXIT_MS = 13_000
/** Without the graceful run nothing is waited for, but a hung request must not keep the process forever. */
export const QUICK_EXIT_MS = 10_000

export interface ShutdownSteps {
  startDraining(): void
  closeSessions(spreadMs: number): void
  /** Stops accepting connections; `done` runs once the last one has ended. */
  closeServer(done: () => void): void
  /** Closes the pool and the telemetry, then exits. */
  finish(): void
  /** The deadline passed: leave now. */
  forceExit(): void
  log(signal: string, graceful: boolean): void
}

export function createShutdown(steps: ShutdownSteps): (signal: string) => void {
  let stopping = false
  return (signal) => {
    if (stopping) return
    stopping = true
    const graceful = signal === 'SIGTERM'
    steps.log(signal, graceful)
    steps.startDraining()
    setTimeout(
      () => {
        steps.closeSessions(graceful ? CLOSE_SPREAD_MS : 0)
        steps.closeServer(() => steps.finish())
      },
      graceful ? DRAIN_MS : 0,
    )
    setTimeout(() => steps.forceExit(), graceful ? HARD_EXIT_MS : QUICK_EXIT_MS).unref()
  }
}
