import type { SafetyStep } from '@ryadom/contracts/api/dialogs'

/**
 * What the screen shows of the crisis script (PROTEUS-279) outside the help sheet. It only grows: the call button,
 * once pinned, stays until the end of the session, and so does the "Need help?" banner.
 */
export interface CrisisUi {
  /** The red branch is on: the sphere holds a still light. */
  active: boolean
  /** The call button is pinned above the conversation. */
  pinned: boolean
  /** The "Need help?" banner after a "no" to the yellow question. */
  banner: boolean
  /** Quick answers to show under the agent's question. */
  ask: 'thoughts' | 'safe' | null
}

export const CRISIS_IDLE: CrisisUi = { active: false, pinned: false, banner: false, ask: null }

const RED_STEPS: readonly SafetyStep[] = ['call', 'check', 'emergency', 'pinned', 'reminder', 'return']

export function reduceCrisisUi(
  prev: CrisisUi,
  next: { step: SafetyStep; pinned: boolean; banner: boolean; ask: 'thoughts' | 'safe' | null },
): CrisisUi {
  return {
    active: prev.active || RED_STEPS.includes(next.step),
    pinned: prev.pinned || next.pinned,
    banner: prev.banner || next.banner,
    // A new step replaces the question: answered or not, the old one is not shown again.
    ask: next.ask,
  }
}
