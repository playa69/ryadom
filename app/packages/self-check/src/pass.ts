import { hasCrisisAnswer } from './score'
import type { SelfCheckTest } from './types'

/**
 * One pass of one test as a state machine without a screen: a tap answers and moves on, «Назад» keeps the answer,
 * «×» after a few answers asks before stopping, and a crisis answer opens the help screen after the last question and
 * before the result. Framework7 and React clients draw it the same way; nothing here touches the network.
 */

export type Phase = 'question' | 'interrupt' | 'crisis' | 'result'

export interface PassState {
  step: number
  answers: (number | null)[]
  phase: Phase
}

/** Answers before «×» asks whether to stop: a couple of taps are not worth a question. */
export const INTERRUPT_FROM = 3

export const startPass = (t: SelfCheckTest): PassState => ({ step: 0, answers: t.items.map(() => null), phase: 'question' })

export function answerPass(t: SelfCheckTest, s: PassState, value: number): PassState {
  const answers = s.answers.slice()
  answers[s.step] = value
  if (s.step < t.items.length - 1) return { ...s, answers, step: s.step + 1 }
  return { ...s, answers, phase: hasCrisisAnswer(t, answers as number[]) ? 'crisis' : 'result' }
}

export const backPass = (s: PassState): PassState => (s.step > 0 ? { ...s, step: s.step - 1 } : s)

export const answeredCount = (s: PassState): number => s.answers.filter((a) => a !== null).length

/** «×»: asks first after `INTERRUPT_FROM` answers while the test is not finished; otherwise the sheet may close. The help screen has no way out. */
export function closePass(t: SelfCheckTest, s: PassState): { state: PassState; closed: boolean } {
  if (s.phase === 'crisis') return { state: s, closed: false }
  if (s.phase === 'question' && answeredCount(s) >= INTERRUPT_FROM && answeredCount(s) < t.items.length) {
    return { state: { ...s, phase: 'interrupt' }, closed: false }
  }
  return { state: s, closed: true }
}

export const resumePass = (s: PassState): PassState => ({ ...s, phase: 'question' })
export const showResult = (s: PassState): PassState => ({ ...s, phase: 'result' })

/** Where in the test the person stopped, a third at a time: never the exact question. */
export function progressThird(t: SelfCheckTest, s: PassState): 'first_third' | 'second_third' | 'last_third' {
  const third = t.items.length / 3
  return s.step < third ? 'first_third' : s.step < 2 * third ? 'second_third' : 'last_third'
}
