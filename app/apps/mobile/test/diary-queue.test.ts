/**
 * The offline queue of mood notes (`REQ-WELL-01`, «Без сети»): the last choice for a day wins, only today and
 * yesterday can still be sent.
 */
import { describe, expect, it } from 'vitest'
import {
  deviceDate,
  enqueueMark,
  parseQueue,
  previousDate,
  removeMark,
  sendableMarks,
} from '../src/client/lib/diary-queue'
import { hardStreak } from '../src/client/components/pages/diary/MoodCard'

describe('очередь отметок без сети', () => {
  it('новая отметка за тот же день заменяет прежнюю, дни идут по порядку', () => {
    let queue = enqueueMark([], { date: '2026-10-24', mood: 2, factor: null })
    queue = enqueueMark(queue, { date: '2026-10-23', mood: 4, factor: 'sleep' })
    queue = enqueueMark(queue, { date: '2026-10-24', mood: 5, factor: 'work' })
    expect(queue).toEqual([
      { date: '2026-10-23', mood: 4, factor: 'sleep' },
      { date: '2026-10-24', mood: 5, factor: 'work' },
    ])
  })

  it('уходит только сегодняшнее и вчерашнее', () => {
    const queue = ['2026-10-21', '2026-10-23', '2026-10-24'].map((date) => ({ date, mood: 3 as const, factor: null }))
    expect(sendableMarks(queue, '2026-10-24').map((m) => m.date)).toEqual(['2026-10-23', '2026-10-24'])
    expect(removeMark(queue, '2026-10-21')).toHaveLength(2)
  })

  it('вчера считается через границу месяца и года', () => {
    expect(previousDate('2026-03-01')).toBe('2026-02-28')
    expect(previousDate('2026-01-01')).toBe('2025-12-31')
    expect(deviceDate(new Date(2026, 9, 5))).toBe('2026-10-05')
  })

  it('читает сохранённое и отбрасывает мусор', () => {
    expect(parseQueue(null)).toEqual([])
    expect(parseQueue('не json')).toEqual([])
    expect(parseQueue(JSON.stringify([{ date: '2026-10-24', mood: 3, factor: null }, { date: 1 }, { date: 'x', mood: 9 }]))).toEqual([
      { date: '2026-10-24', mood: 3, factor: null },
    ])
  })
})

describe('мост к разговору', () => {
  it('считает дни «Тяжело» подряд, заканчивающиеся сегодня', () => {
    const month = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'].map((date) => ({
      date,
      mood: 1 as const,
      factor: null,
    }))
    expect(hardStreak(month, '2026-10-24')).toBe(4)
    expect(hardStreak(month.slice(0, 2), '2026-10-24')).toBe(0)
    expect(hardStreak([...month.slice(0, 1), { date: '2026-10-24', mood: 1, factor: null }], '2026-10-24')).toBe(1)
  })
})
