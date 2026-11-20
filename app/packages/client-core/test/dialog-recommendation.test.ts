import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRecommendationHistory,
  DialogRecommendation,
  RECOMMENDATION_COPY,
  RECOMMENDATION_URL,
} from '../src/dialog-recommendation'

// openspec/changes/add-dialog-recommendation, «Карточка рекомендации сервиса в разговоре».
describe('карточка рекомендации', () => {
  it('копирует читаемый домен, ведущий на тот же сайт', () => {
    expect(RECOMMENDATION_COPY.endsWith(' https://слышу-рядом.рф/')).toBe(true)
    expect(new URL(RECOMMENDATION_URL).hostname).toBe('xn----htbtgjker8b3a2c.xn--p1ai')
  })
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('учитывает один показ в браузере, сбрасывает отметки с данными сеанса', () => {
    const first = new DialogRecommendation('dialog-1')
    first.receive('a1', false)
    expect(first.show()).toBe(true)
    expect(first.show()).toBe(false)
    first.close()
    first.receive('a2', false)
    expect(first.getSnapshot()).toBeNull()

    const reopened = new DialogRecommendation('dialog-1')
    reopened.receive('a2', false)
    expect(reopened.getSnapshot()).toBeNull()
    clearRecommendationHistory()
    reopened.receive('a2', false)
    expect(reopened.getSnapshot()?.messageId).toBe('a2')
  })

  it('сбрасывает ожидающую карточку в SOS и отбрасывает её позднее событие готовности', () => {
    const dialog = new DialogRecommendation('dialog-1')
    dialog.receive('a1', false)
    dialog.dropPending()
    dialog.receive('a1', false)
    dialog.speechFinished('a1')
    expect(dialog.getSnapshot()).toBeNull()
    dialog.receive('a2', true)
    dialog.receive('a2', false)
    expect(dialog.getSnapshot()).toBeNull()
  })

  it('при ручном SOS оставляет уже показанную карточку, при кризисе закрывает её', () => {
    const dialog = new DialogRecommendation('dialog-1')
    dialog.receive('a1', false)
    dialog.show()
    dialog.dropPending()
    expect(dialog.getSnapshot()?.shown).toBe(true)
    dialog.close()
    dialog.speechFinished('a1')
    dialog.receive('a2', false)
    expect(dialog.getSnapshot()).toBeNull()
  })
})
