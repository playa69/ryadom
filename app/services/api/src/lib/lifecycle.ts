/**
 * Where the process is in its life, for the parts that must behave differently while it is being
 * stopped. A pod that got SIGTERM keeps serving for a few seconds: the balancer needs
 * that long to stop sending it traffic. During those seconds it is "draining": the health check
 * says so, and a dialog socket that still arrives is turned away at once.
 */

let draining = false

export function isDraining(): boolean {
  return draining
}

export function startDraining(): void {
  draining = true
}

/** For tests only: a process never leaves the draining phase. */
export function resetDraining(): void {
  draining = false
}
