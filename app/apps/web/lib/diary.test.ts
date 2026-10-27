/** Pure parts of the web diary (`REQ-WELL-01`): segments and the storage key of the last segment. */
import { describe, expect, it } from 'vitest'
import { DIARY_SEGMENTS, deviceToday, segmentHref } from './diary'
import { WEB_DIARY_SEGMENT_KEY, WEB_STORAGE_PREFIX } from './storage-keys'

describe('дневник в вебе', () => {
  it('сегменты — «Дневник · Журнал · Тесты», «Тесты» по адресу /diary/tests', () => {
    expect(DIARY_SEGMENTS.map((s) => s.label)).toEqual(['Дневник', 'Журнал', 'Тесты'])
    expect(DIARY_SEGMENTS.map((s) => s.href)).toEqual(['/diary', '/diary/journal', '/diary/tests'])
  })

  it('адрес сегмента берётся из списка, а «Дневник» — запасной', () => {
    expect(segmentHref('journal')).toBe('/diary/journal')
    expect(DIARY_SEGMENTS[0]?.href).toBe('/diary')
  })

  it('сегодня на устройстве — местная дата, а не UTC', () => {
    expect(deviceToday(new Date(2026, 9, 5, 0, 30))).toBe('2026-10-05')
  })

  it('ключ последнего сегмента лежит в пространстве веба', () => {
    expect(WEB_DIARY_SEGMENT_KEY.startsWith(WEB_STORAGE_PREFIX)).toBe(true)
  })
})
