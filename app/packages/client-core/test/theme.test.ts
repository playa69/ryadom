/**
 * Schedule and storage of the day/night palette shared by Web, PWA and Telegram.
 */
// openspec/changes/add-fast-dialog-start — requirement «Русскоязычный интерфейс и оформление».
import { describe, expect, it } from 'vitest'
import {
  msToNextThemeBoundary,
  nextThemeBoundary,
  readThemeOverride,
  resolveTheme,
  saveThemeOverride,
  THEME_STORAGE_KEY,
  themeForTime,
  type ThemeStorage,
} from '../src/theme'

// Fixed dates with no DST transition anywhere, so exact millisecond delays hold in every timezone.
const at = (hour: number, minute = 0, day = 15) => new Date(2026, 10, day, hour, minute, 0, 0)

describe('тема по местному времени (add-fast-dialog-start)', () => {
  it('границы 06:59/07:00/21:59/22:00 — тёмная, светлая, светлая, тёмная (сценарий «Границы темы»)', () => {
    expect(themeForTime(at(6, 59))).toBe('dark')
    expect(themeForTime(at(7, 0))).toBe('light')
    expect(themeForTime(at(21, 59))).toBe('light')
    expect(themeForTime(at(22, 0))).toBe('dark')
  })

  it('день светлый, ночь тёмная (сценарии «Дневное оформление» и «Ночное оформление»)', () => {
    expect(themeForTime(at(12, 0))).toBe('light')
    expect(themeForTime(at(0, 0))).toBe('dark')
    expect(themeForTime(at(3, 0))).toBe('dark')
    expect(themeForTime(at(23, 0))).toBe('dark')
  })
})

describe('следующая граница темы (add-fast-dialog-start)', () => {
  it('до 07:00 — сегодняшние 07:00, на них и ставится таймер', () => {
    expect(nextThemeBoundary(at(6, 59))).toEqual(at(7, 0))
    expect(msToNextThemeBoundary(at(6, 59))).toBe(60_000)
    expect(msToNextThemeBoundary(at(6, 0))).toBe(3_600_000)
  })

  it('днём — сегодняшние 22:00', () => {
    expect(nextThemeBoundary(at(12, 0))).toEqual(at(22, 0))
    expect(msToNextThemeBoundary(at(12, 0))).toBe(36_000_000)
    expect(msToNextThemeBoundary(at(21, 30))).toBe(1_800_000)
  })

  it('после 22:00 — завтрашние 07:00, через полночь', () => {
    expect(nextThemeBoundary(at(23, 0))).toEqual(at(7, 0, 16))
    expect(msToNextThemeBoundary(at(23, 0))).toBe(28_800_000)
  })

  it('ровно на границе — уже следующая: повторный таймер не сработает в ноль', () => {
    expect(nextThemeBoundary(at(7, 0))).toEqual(at(22, 0))
    expect(nextThemeBoundary(at(22, 0))).toEqual(at(7, 0, 16))
  })
})

describe('ручной выбор темы (add-fast-dialog-start)', () => {
  const memoryStorage = (
    initial: Record<string, string> = {},
  ): ThemeStorage & { data: Record<string, string> } => ({
    data: { ...initial },
    getItem(key) {
      const value = this.data[key]
      return typeof value === 'string' ? value : null
    },
    setItem(key, value) {
      this.data[key] = value
    },
  })

  it('чтение сохранённого выбора: светлого и тёмного (сценарий «Ручной выбор сохраняется»)', () => {
    expect(readThemeOverride(memoryStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light')
    expect(readThemeOverride(memoryStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
  })

  it('сохранение пишет только локальный ключ выбора', () => {
    const storage = memoryStorage()
    saveThemeOverride(storage, 'dark')
    expect(storage.data).toEqual({ [THEME_STORAGE_KEY]: 'dark' })
    expect(readThemeOverride(storage)).toBe('dark')
  })

  it('нет значения или мусор вместо темы — «нет выбора», действует расписание', () => {
    expect(readThemeOverride(memoryStorage())).toBeNull()
    expect(readThemeOverride(memoryStorage({ [THEME_STORAGE_KEY]: 'blue' }))).toBeNull()
    expect(readThemeOverride(memoryStorage({ [THEME_STORAGE_KEY]: '' }))).toBeNull()
  })

  it('хранилище бросает — чтение даёт «нет выбора», запись не падает', () => {
    const broken: ThemeStorage = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    }
    expect(readThemeOverride(broken)).toBeNull()
    expect(() => saveThemeOverride(broken, 'light')).not.toThrow()
  })

  it('ручной выбор важнее расписания до следующего ручного изменения; без него — расписание', () => {
    expect(resolveTheme(at(12, 0), 'dark')).toBe('dark')
    expect(resolveTheme(at(23, 0), 'light')).toBe('light')
    expect(resolveTheme(at(12, 0), null)).toBe('light')
    expect(resolveTheme(at(23, 0), null)).toBe('dark')
  })
})
