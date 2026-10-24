/**
 * Pure parts of the web diary (`REQ-WELL-01`, `REQ-WELL-02`): segments, reminder times, the picture
 * of the year, the storage key of the last segment.
 */
import { describe, expect, it } from 'vitest'
import { DIARY_SEGMENTS, REMINDER_TIMES, deviceToday, segmentHref } from './diary'
import { WEB_DIARY_SEGMENT_KEY, WEB_STORAGE_PREFIX } from './storage-keys'
import { YEAR_IMAGE_FOOTER, yearImageFileName } from './year-image'

describe('дневник в вебе', () => {
  it('сегменты идут в порядке «Дневник · Итоги · Год · Тесты» и ведут на свои адреса', () => {
    expect(DIARY_SEGMENTS.map((s) => s.label)).toEqual(['Дневник', 'Итоги', 'Год', 'Тесты'])
    expect(DIARY_SEGMENTS.map((s) => segmentHref(s.key))).toEqual(['/diary', '/diary/recaps', '/diary/year', '/diary/tests'])
  })

  it('время напоминания: с 08:00 до 22:30 с шагом 30 минут', () => {
    expect(REMINDER_TIMES[0]).toBe('08:00')
    expect(REMINDER_TIMES.at(-1)).toBe('22:30')
    expect(REMINDER_TIMES).toContain('20:00')
    expect(REMINDER_TIMES).toHaveLength(30)
  })

  it('картинка года: имя файла и подпись, без дат и факторов', () => {
    expect(yearImageFileName(2026)).toBe('ryadom-2026.png')
    expect(YEAR_IMAGE_FOOTER).toBe('Мой год в Слышу Рядом · слышу-рядом.рф')
  })

  it('сегодня на устройстве — местная дата, а не UTC', () => {
    expect(deviceToday(new Date(2026, 9, 5, 0, 30))).toBe('2026-10-05')
  })

  it('ключ последнего сегмента лежит в пространстве веба', () => {
    expect(WEB_DIARY_SEGMENT_KEY.startsWith(WEB_STORAGE_PREFIX)).toBe(true)
  })
})
