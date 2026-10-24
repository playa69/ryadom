import { describe, expect, it } from 'vitest'
import { addDaysToDate, isValidDate, localMoment, minutesToTime, timeToMinutes, weekStart } from '../src/diary/local-time'

describe('местное время человека (REQ-WELL-01)', () => {
  it('Владивосток в 00:30 — уже новый местный день, а в Москве ещё вчера', () => {
    const now = new Date('2026-10-23T14:30:00Z') // 00:30 on 24 Oct in Vladivostok (UTC+10), 17:30 in Moscow
    expect(localMoment(now, 'Asia/Vladivostok')).toMatchObject({ date: '2026-10-24', minutes: 30 })
    expect(localMoment(now, 'Europe/Moscow').date).toBe('2026-10-23')
  })

  it('неделя — с понедельника, воскресенье относится к своей неделе', () => {
    expect(weekStart('2026-10-24')).toBe('2026-10-19') // Saturday
    expect(weekStart('2026-10-25')).toBe('2026-10-19') // Sunday
    expect(weekStart('2026-10-26')).toBe('2026-10-26') // Monday
    expect(localMoment(new Date('2026-10-25T12:00:00Z'), 'Europe/Moscow').isoWeekday).toBe(7)
  })

  it('даты: сдвиг через границу месяца, проверка существования, время в минутах', () => {
    expect(addDaysToDate('2026-02-28', 1)).toBe('2026-03-01')
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('2026-10-24')).toBe(true)
    expect(timeToMinutes('20:30:00')).toBe(1230)
    expect(minutesToTime(1230)).toBe('20:30')
  })
})
