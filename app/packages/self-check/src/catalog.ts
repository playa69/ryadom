import type { SelfCheckTest } from './types'
import { burnout } from './tests/burnout'
import { gad7 } from './tests/gad7'
import { miniIpip } from './tests/miniipip'
import { phq9 } from './tests/phq9'
import { rosenberg } from './tests/rosenberg'
import { stress } from './tests/stress'
import { wellbeing } from './tests/wellbeing'

/** Волна 1 — «Самопроверка». */
export const wave1: readonly SelfCheckTest[] = [gad7, phq9, rosenberg, wellbeing, stress, burnout]

/** Тесты, которые видны в продакшене: только `ready`. */
export const catalog = (all: readonly SelfCheckTest[] = wave1): SelfCheckTest[] =>
  all.filter((t) => t.status === 'ready')

export const byId = (id: string, all: readonly SelfCheckTest[] = wave1) => all.find((t) => t.id === id)

/** Волна 2 — неклинические опросники каталога «Тесты» (дополняется). */
export const wave2: readonly SelfCheckTest[] = [miniIpip]

/** Tests to show: only those the owner has signed off (`ready`); `review` and `blocked` stay out of every build. */
export const visible = (all: readonly SelfCheckTest[] = [...wave1, ...wave2]): SelfCheckTest[] =>
  all.filter((t) => t.status === 'ready')
