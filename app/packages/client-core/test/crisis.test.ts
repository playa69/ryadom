import { describe, expect, it } from 'vitest'
import { SafetyLevel } from '@ryadom/contracts/api/dialogs'
import { CRISIS_IDLE, createCrisisStore, reduceSafety, watchHelpReturn } from '../src/crisis'

// openspec/changes/extend-crisis-branch, «Скрипт красного уровня»
describe('reduceSafety', () => {
  it('кадр без stage (старый агент) открывает обычный лист', () => {
    expect(reduceSafety(CRISIS_IDLE, { level: SafetyLevel.Crisis })).toEqual({ ui: CRISIS_IDLE, sheet: 'default' })
  })

  it('идёт по шагам скрипта', () => {
    const store = createCrisisStore()
    expect(store.onSafety({ level: SafetyLevel.Crisis, stage: 'help' })).toBe('help')
    expect(store.onSafety({ level: SafetyLevel.Crisis, stage: 'ask_safe' })).toBe(null)
    expect(store.getSnapshot().ui.askSafe).toBe(true)
    expect(store.onSafety({ level: SafetyLevel.Crisis, stage: 'call112' })).toBe('call112')
    expect(store.getSnapshot().ui.askSafe).toBe(false)
    expect(store.onSafety({ level: SafetyLevel.Crisis, stage: 'stay', showCall: true })).toBe('close')
    expect(store.getSnapshot().ui.pinCall).toBe(true)
    store.reset()
    expect(store.getSnapshot().ui).toEqual(CRISIS_IDLE)
  })

  it('жёлтый уровень: вопрос ничего не меняет, calm даёт плашку и спокойный шар', () => {
    const asked = reduceSafety(CRISIS_IDLE, { level: SafetyLevel.Concern, stage: 'ask_hopeless' })
    expect(asked).toEqual({ ui: CRISIS_IDLE, sheet: null })
    const calm = reduceSafety(CRISIS_IDLE, { level: SafetyLevel.Concern, stage: 'calm' })
    expect(calm.ui).toMatchObject({ active: true, banner: true })
    expect(calm.sheet).toBe(null)
  })

  it('ответ уходит обработчиком и гасит кнопки', () => {
    const store = createCrisisStore()
    const sent: string[] = []
    store.setAnswerHandler((text) => sent.push(text))
    store.onSafety({ level: SafetyLevel.Crisis, stage: 'ask_safe' })
    store.answer('Не знаю')
    expect(sent).toEqual(['Не знаю'])
    expect(store.getSnapshot().ui.askSafe).toBe(false)
  })
})

describe('watchHelpReturn', () => {
  function fakeEnv() {
    const handlers = new Map<string, Array<(event: unknown) => void>>()
    const target = (name: string) => ({
      addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(`${name}:${type}`, [...(handlers.get(`${name}:${type}`) ?? []), fn]),
      removeEventListener: () => {},
    })
    const doc = { ...target('doc'), visibilityState: 'visible' } as unknown as Document & { visibilityState: string }
    const win = target('win') as unknown as Window
    const fire = (key: string, event: unknown = {}) => handlers.get(key)?.forEach((fn) => fn(event))
    return { doc, win, fire }
  }
  const telTap = { target: { closest: () => ({}) } }

  it('сообщает о возврате один раз после звонка', () => {
    const { doc, win, fire } = fakeEnv()
    let returns = 0
    watchHelpReturn(() => (returns += 1), doc, win)
    fire('win:focus')
    expect(returns, 'без звонка возврата нет').toBe(0)
    fire('doc:click', telTap)
    fire('win:blur')
    fire('win:focus')
    fire('win:focus')
    expect(returns).toBe(1)
  })

  it('не считает нажатие не на tel:', () => {
    const { doc, win, fire } = fakeEnv()
    let returns = 0
    watchHelpReturn(() => (returns += 1), doc, win)
    fire('doc:click', { target: { closest: () => null } })
    fire('win:blur')
    fire('win:focus')
    expect(returns).toBe(0)
  })
})
