/**
 * Whether pressing "start" has to ask the person about the conversation they left open, and what to do
 * when the open one is in the other memory mode than the one they chose.
 */
import { describe, expect, it } from 'vitest'
import type { StartDialogApiResponse } from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { chosenMemoryMode, chosenStart, nextStartStep, shouldAskToResume } from '../src/dialog-start'

const start = (patch: Partial<StartDialogApiResponse>): StartDialogApiResponse => ({
  dialogId: 'd-1',
  resumed: false,
  greeting: null,
  sinceLastDialogHours: null,
  messageCount: 0,
  lastActivityAt: null,
  memoryMode: DialogMemoryMode.On,
  memoryEnabled: false,
  ...patch,
})

describe('спрашивать ли про незавершённый разговор', () => {
  it('открытый диалог с репликами — спрашиваем', () => {
    expect(shouldAskToResume(start({ resumed: true, messageCount: 1 }))).toBe(true)
    expect(shouldAskToResume(start({ resumed: true, messageCount: 42 }))).toBe(true)
  })

  it('открытый, но пустой диалог — не спрашиваем, терять нечего: сразу продолжаем', () => {
    expect(shouldAskToResume(start({ resumed: true, messageCount: 0 }))).toBe(false)
  })

  it('новый диалог — не спрашиваем, как бы ни выглядел счётчик', () => {
    expect(shouldAskToResume(start({ resumed: false, messageCount: 0 }))).toBe(false)
    expect(shouldAskToResume(start({ resumed: false, messageCount: 5 }))).toBe(false)
  })

  it('шлюз старее клиента не прислал messageCount — не спрашиваем, как до появления вопроса', () => {
    const legacy = { resumed: true } as Pick<StartDialogApiResponse, 'resumed' | 'messageCount'>
    expect(shouldAskToResume(legacy)).toBe(false)
  })
})

describe('«Без памяти» на главной', () => {
  it('переключатель есть только при включённой памяти: иначе режим не выбирается и не отправляется', () => {
    expect(chosenMemoryMode(undefined, true)).toBeUndefined()
    expect(chosenMemoryMode(false, true)).toBeUndefined()
    expect(chosenMemoryMode(true, true)).toBe(DialogMemoryMode.Off)
    expect(chosenMemoryMode(true, false)).toBe(DialogMemoryMode.On)
  })
})

describe('что делать с ответом старта', () => {
  it('открытый с репликами — вопрос, в каком бы режиме он ни был', () => {
    expect(nextStartStep(start({ resumed: true, messageCount: 3 }), DialogMemoryMode.Off)).toBe('ask')
    expect(nextStartStep(start({ resumed: true, messageCount: 3 }), undefined)).toBe('ask')
  })

  it('открытый пустой в другом режиме — завершить и начать новый в выбранном, не спрашивая', () => {
    const empty = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.On })
    expect(nextStartStep(empty, DialogMemoryMode.Off)).toBe('restart')
    const offEmpty = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.Off })
    expect(nextStartStep(offEmpty, DialogMemoryMode.On)).toBe('restart')
  })

  it('открытый пустой в том же режиме или без выбора — просто открыть', () => {
    const empty = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.Off })
    expect(nextStartStep(empty, DialogMemoryMode.Off)).toBe('open')
    expect(nextStartStep(empty, undefined)).toBe('open')
  })

  it('новый диалог — открыть', () => {
    expect(nextStartStep(start({ memoryMode: DialogMemoryMode.Off }), DialogMemoryMode.Off)).toBe('open')
  })

  it('шлюз без memoryMode — открыть, как раньше', () => {
    const legacy = { resumed: true, messageCount: 0 } as Pick<
      StartDialogApiResponse,
      'resumed' | 'messageCount' | 'memoryMode'
    >
    expect(nextStartStep(legacy, DialogMemoryMode.Off)).toBe('open')
  })
})

describe('«Не сохранять этот разговор» на главной (add-unsaved-dialog)', () => {
  it('отдельный выбор: галочка не зависит от памяти и не просит память; «Без памяти» без галочки не уходит в saved', () => {
    expect(chosenStart(true, false, true)).toEqual({ memory: undefined, saved: false })
    expect(chosenStart(false, false, true)).toEqual({ memory: undefined, saved: false })
    expect(chosenStart(undefined, true, true)).toEqual({ memory: undefined, saved: false })
    expect(chosenStart(true, true, false)).toEqual({ memory: DialogMemoryMode.Off, saved: true })
    expect(chosenStart(true, false, false)).toEqual({ memory: DialogMemoryMode.On, saved: true })
    expect(chosenStart(false, false, false)).toEqual({ memory: undefined, saved: true })
  })

  it('открытый пустой с другим выбором «сохранять» — завершить и начать новый, не спрашивая', () => {
    const saved = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.On, saved: true })
    expect(nextStartStep(saved, undefined, false)).toBe('restart')
    const unsaved = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.Off, saved: false })
    expect(nextStartStep(unsaved, DialogMemoryMode.On, true)).toBe('restart')
    expect(nextStartStep(unsaved, undefined, true)).toBe('restart')
  })

  it('открытый пустой с тем же выбором — открыть; у не сохраняемого память off, и это не повод пересоздавать', () => {
    const unsaved = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.Off, saved: false })
    expect(nextStartStep(unsaved, undefined, false)).toBe('open')
    const saved = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.On, saved: true })
    expect(nextStartStep(saved, DialogMemoryMode.On, true)).toBe('open')
  })

  it('открытый с репликами — вопрос, и у не сохраняемого тоже', () => {
    const unsaved = start({ resumed: true, messageCount: 4, memoryMode: DialogMemoryMode.Off, saved: false })
    expect(nextStartStep(unsaved, undefined, true)).toBe('ask')
  })

  it('шлюз без saved — как «сохраняется»: с галочкой пересоздаём пустой, без неё открываем', () => {
    const legacy = start({ resumed: true, messageCount: 0, memoryMode: DialogMemoryMode.On })
    expect(nextStartStep(legacy, undefined, false)).toBe('restart')
    expect(nextStartStep(legacy, undefined, true)).toBe('open')
  })
})
