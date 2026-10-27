import type { SelfCheckTest } from './types'
import { burnout } from './tests/burnout'
import { gad7 } from './tests/gad7'
import { k6 } from './tests/k6'
import { miniIpip } from './tests/miniipip'
import { phq9 } from './tests/phq9'
import { rosenberg } from './tests/rosenberg'
import { gad2, phq2 } from './tests/short'
import { swls } from './tests/swls'
import { stress } from './tests/stress'
import { wellbeing } from './tests/wellbeing'

/** Волна 1 — «Самопроверка». */
export const wave1: readonly SelfCheckTest[] = [gad7, phq9, rosenberg, wellbeing, stress, burnout]

/** Тесты, которые видны в продакшене: только `ready`. */
export const catalog = (all: readonly SelfCheckTest[] = wave1): SelfCheckTest[] =>
  all.filter((t) => t.status === 'ready')

export const byId = (id: string, all: readonly SelfCheckTest[] = [...wave1, ...wave2]) => all.find((t) => t.id === id)

/** Волна 2 — неклинические опросники каталога «Тесты» (дополняется). */
export const wave2: readonly SelfCheckTest[] = [swls, k6, phq2, gad2, miniIpip]

/**
 * Tests to show: only `ready` in production; with `preview` (a dev stack, staging) also those still in
 * review, so the flow can be walked before the owner signs the texts off. `blocked` is never shown.
 */
export const visible = (preview: boolean, all: readonly SelfCheckTest[] = [...wave1, ...wave2]): SelfCheckTest[] =>
  all.filter((t) => t.status === 'ready' || (preview && t.status === 'review'))
