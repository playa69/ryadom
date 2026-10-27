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

/** Волна 2 — неклинические опросники каталога «Тесты» (дополняется). */
export const wave2: readonly SelfCheckTest[] = [miniIpip]

/** Все тесты каталога «Тесты»: волна 1 и волна 2. Показываются все. */
export const allTests: readonly SelfCheckTest[] = [...wave1, ...wave2]

export const byId = (id: string, all: readonly SelfCheckTest[] = allTests) => all.find((t) => t.id === id)
