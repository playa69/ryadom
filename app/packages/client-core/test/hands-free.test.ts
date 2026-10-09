import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDS_FREE_HINT, pausedHint, readHandsFree, writeHandsFree } from '../src/voice/hands-free'

const KEY = 'test.hands-free'

function stubStorage(): Map<string, string> {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  })
  return values
}

afterEach(() => vi.unstubAllGlobals())

describe('настройка «Разговор без рук»', () => {
  it('по умолчанию включена', () => {
    stubStorage()
    expect(readHandsFree(KEY)).toBe(true)
  })

  it('выключение запоминается, включение возвращает умолчание', () => {
    const values = stubStorage()
    writeHandsFree(KEY, false)
    expect(readHandsFree(KEY)).toBe(false)
    writeHandsFree(KEY, true)
    expect(readHandsFree(KEY)).toBe(true)
    expect(values.size).toBe(0)
  })

  it('недоступное хранилище — это умолчание, а не ошибка', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => writeHandsFree(KEY, false)).not.toThrow()
    expect(readHandsFree(KEY)).toBe(true)
  })
})

describe('подписи под шаром', () => {
  it('после двух минут тишины — своя фраза, иначе «на паузе»', () => {
    expect(pausedHint('idle')).toBe('Я рядом. Скажи что-нибудь или нажми, чтобы продолжить')
    expect(pausedHint('manual')).toBe(HANDS_FREE_HINT.paused)
    expect(pausedHint('background')).toBe('Микрофон на паузе')
    expect(HANDS_FREE_HINT.speaking).toBe('Просто начни говорить, чтобы перебить')
  })
})
