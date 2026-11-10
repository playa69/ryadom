import type { Page } from '@playwright/test'

/** How the browser answers the microphone request in a journey. */
export interface MicStub {
  /**
   * `hold`: the request stays open until `settleMic` (the system prompt on the screen, the person deciding);
   * `grant`: the fake device opens at once; an error name (`NotAllowedError`, `NotFoundError`, ...): refused at once.
   */
  outcome: 'hold' | 'grant' | string
  /** What `navigator.permissions.query` says; `null`: the browser cannot say (Safari). */
  permission?: 'granted' | 'denied' | 'prompt' | null
}

/**
 * A scripted microphone: `getUserMedia` and `permissions.query` answer as the journey says, and the page keeps
 * a count of the requests. A headless browser shows no system prompt, so the moment of it is a request held open.
 */
export async function stubMic(page: Page, stub: MicStub): Promise<void> {
  await page.addInitScript((initial) => {
    type Settle = (outcome: string) => void
    const state = {
      calls: 0,
      outcome: initial.outcome,
      settle: null as Settle | null,
    }
    const mic = state as typeof state & { setPermission?: (next: string) => void }
    ;(window as unknown as { __mic: typeof mic }).__mic = mic

    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    const answer = (outcome: string, constraints: MediaStreamConstraints): Promise<MediaStream> =>
      outcome === 'grant'
        ? real(constraints)
        : Promise.reject(new DOMException('scripted', outcome))
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: (constraints: MediaStreamConstraints) => {
        state.calls += 1
        if (state.outcome !== 'hold') return answer(state.outcome, constraints)
        return new Promise<MediaStream>((resolve, reject) => {
          state.settle = (outcome) => answer(outcome, constraints).then(resolve, reject)
        })
      },
    })

    if (initial.permission === null) {
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: () => Promise.reject(new TypeError('microphone')) },
      })
      return
    }
    const status = Object.assign(new EventTarget(), { state: initial.permission ?? 'prompt' })
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: () => Promise.resolve(status) },
    })
    mic.setPermission = (next) => {
      status.state = next
      status.dispatchEvent(new Event('change'))
    }
  }, stub)
}

/** The person answers the held request (grants it, or refuses with the error the browser would raise). */
export function settleMic(page: Page, outcome: 'grant' | string): Promise<void> {
  return page.evaluate((value) => {
    ;(window as unknown as { __mic: { settle: ((o: string) => void) | null } }).__mic.settle?.(value)
  }, outcome)
}

/** From now on the browser answers at once, the way it does after a refusal it remembers. */
export function answerMic(page: Page, outcome: 'grant' | string): Promise<void> {
  return page.evaluate((value) => {
    ;(window as unknown as { __mic: { outcome: string } }).__mic.outcome = value
  }, outcome)
}

/** The person flips the switch in the browser's settings. */
export function setMicPermission(page: Page, state: 'granted' | 'denied' | 'prompt'): Promise<void> {
  return page.evaluate((value) => {
    ;(window as unknown as { __mic: { setPermission?: (s: string) => void } }).__mic.setPermission?.(value)
  }, state)
}

/** How many times the page asked the browser for the microphone. */
export function micRequests(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __mic: { calls: number } }).__mic.calls)
}
