/** Where the app's own addresses lead: the journal tab moved into the diary. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('framework7-react', () => ({ f7: {}, f7ready: () => undefined }))

import { currentRoute, isAppRoute, requestTalkOnHome, TAB_IDS, takeTalkRequest } from '../src/client/lib/nav'

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
})
