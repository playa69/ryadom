/** Where the app's own addresses lead: the journal tab moved into the diary. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('framework7-react', () => ({ f7: {}, f7ready: () => undefined }))

import {
  currentRoute,
  draftIntent,
  hasDraftText,
  isAppRoute,
  requestTalkOnHome,
  TAB_IDS,
  takeTalkRequest,
} from '../src/client/lib/nav'

describe('адреса приложения', () => {
  it('старый адрес журнала ведёт в «Дневник → Журнал», остальные не меняются', () => {
    expect(currentRoute('/journal/')).toBe('/diary/journal/')
    expect(currentRoute('/journal/abc-1/')).toBe('/diary/journal/abc-1/')
    expect(currentRoute('/diary/journal/abc-1/')).toBe('/diary/journal/abc-1/')
    expect(currentRoute('/diary/')).toBe('/diary/')
    expect(currentRoute('/home/')).toBe('/home/')
  })

  it('внешним адресом может быть только свой экран', () => {
    for (const route of ['/diary/journal/', '/diary/journal/abc/', '/journal/', '/dialog/x/', '/profile/']) {
      expect(isAppRoute(route), route).toBe(true)
    }
    for (const route of ['https://example.com/', '//evil/', '/other/', 42])
      expect(isAppRoute(route), String(route)).toBe(false)
  })

  it('вкладок три: журнала среди них нет', () => {
    expect(Object.keys(TAB_IDS)).toEqual(['home', 'diary', 'profile'])
  })

  it('с первого экрана на главный переносится только выбор памяти и только один раз', () => {
    // `openspec/changes/remove-unsaved-dialog-option`, «Галочка «Не сохранять этот разговор»».
    requestTalkOnHome({ rememberMemory: true })
    expect(takeTalkRequest()).toEqual({ rememberMemory: true })
    expect(takeTalkRequest()).toBeNull()
  })

  it('с первого экрана переносится и первый текст с намерением, тоже один раз', () => {
    // `openspec/changes/add-fast-dialog-start`, «Первый экран: разговор с первого действия».
    requestTalkOnHome({ rememberMemory: false, draft: 'Мне тревожно', listen: false })
    expect(takeTalkRequest()).toEqual({ rememberMemory: false, draft: 'Мне тревожно', listen: false })
    expect(takeTalkRequest()).toBeNull()
  })

  it('«Продолжить» листа согласия переносит намерение через вход тем же одноразовым каналом', () => {
    // `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии»
    // («Подтверждение продолжает исходное действие»): голосовое намерение переживает вход.
    requestTalkOnHome({ rememberMemory: false, draft: '', listen: true })
    expect(takeTalkRequest()).toEqual({ rememberMemory: false, draft: '', listen: true })
    expect(takeTalkRequest()).toBeNull()
  })
})

describe('намерение черновика', () => {
  // `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента»
  // («(PWA, Telegram) Поле ограничивает черновик») и «Начало разговора с главного экрана».

  it('пустой черновик и одни пробелы — голосовой старт с прослушиванием', () => {
    expect(draftIntent('')).toEqual({ draft: '', listen: true })
    expect(draftIntent('   \n ')).toEqual({ draft: '', listen: true })
    expect(hasDraftText('')).toBe(false)
    expect(hasDraftText('  ')).toBe(false)
  })

  it('непустой черновик — текстовый старт без прослушивания, текст обрезан по краям', () => {
    expect(draftIntent('  Мне тревожно \n')).toEqual({ draft: 'Мне тревожно', listen: false })
    expect(hasDraftText('Просто поговорить')).toBe(true)
  })
})
