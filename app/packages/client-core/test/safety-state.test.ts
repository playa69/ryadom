import { describe, expect, it } from 'vitest'
import { CRISIS_IDLE, reduceCrisisUi } from '../src/safety-state'

describe('состояние кризисного сценария на экране', () => {
  it('красный шаг включает кризис и закрепляет кнопку', () => {
    const next = reduceCrisisUi(CRISIS_IDLE, { step: 'call', pinned: true, banner: false, ask: null })
    expect(next).toEqual({ active: true, pinned: true, banner: false, ask: null })
  })

  it('жёлтый вопрос не включает кризис и не закрепляет кнопку', () => {
    const next = reduceCrisisUi(CRISIS_IDLE, { step: 'ask_thoughts', pinned: false, banner: false, ask: 'thoughts' })
    expect(next).toEqual({ active: false, pinned: false, banner: false, ask: 'thoughts' })
  })

  it('плашка после «нет» остаётся до конца сессии, вопрос снимается', () => {
    const asked = reduceCrisisUi(CRISIS_IDLE, { step: 'ask_thoughts', pinned: false, banner: false, ask: 'thoughts' })
    const banner = reduceCrisisUi(asked, { step: 'banner', pinned: false, banner: true, ask: null })
    expect(banner).toEqual({ active: false, pinned: false, banner: true, ask: null })
    expect(reduceCrisisUi(banner, { step: 'banner', pinned: false, banner: false, ask: null }).banner).toBe(true)
  })

  it('закреплённая кнопка не снимается следующим кадром', () => {
    const pinned = reduceCrisisUi(CRISIS_IDLE, { step: 'pinned', pinned: true, banner: false, ask: null })
    expect(reduceCrisisUi(pinned, { step: 'return', pinned: false, banner: false, ask: null }).pinned).toBe(true)
  })
})
