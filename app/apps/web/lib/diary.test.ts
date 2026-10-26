/** Pure parts of the web diary (`REQ-WELL-01`): segments and the storage key of the last segment. */
import { describe, expect, it, vi } from 'vitest'
import { DIARY_SEGMENTS, deviceToday, segmentHref } from './diary'
import { WEB_DIARY_SEGMENT_KEY, WEB_STORAGE_PREFIX } from './storage-keys'

describe('дневник в вебе', () => {
  it('без тестов сегменты — «Дневник · Журнал», «Тесты» нет (add-self-check-tests, D9)', () => {
    expect(DIARY_SEGMENTS.map((s) => s.label)).toEqual(['Дневник', 'Журнал'])
    expect(DIARY_SEGMENTS.map((s) => segmentHref(s.key))).toEqual(['/diary', '/diary/journal'])
  })

  it('с включёнными тестами третий сегмент — «Тесты» по адресу /diary/tests', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_CHECK_ENABLED', '1')
    vi.resetModules()
    const on = await import('./diary')
    expect(on.DIARY_SEGMENTS.map((s) => s.label)).toEqual(['Дневник', 'Журнал', 'Тесты'])
    expect(on.segmentHref('tests')).toBe('/diary/tests')
    vi.unstubAllEnvs()
  })

  it('сегодня на устройстве — местная дата, а не UTC', () => {
    expect(deviceToday(new Date(2026, 9, 5, 0, 30))).toBe('2026-10-05')
  })

  it('ключ последнего сегмента лежит в пространстве веба', () => {
    expect(WEB_DIARY_SEGMENT_KEY.startsWith(WEB_STORAGE_PREFIX)).toBe(true)
  })
})
