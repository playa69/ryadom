import { describe, expect, it } from 'vitest'
import {
  bridgeFor,
  buildChart,
  buildYearGrid,
  chartAlt,
  dayCaption,
  mostFrequentMood,
  weekStartOf,
} from '../src/diary'

describe('помощники дневника (REQ-WELL-01)', () => {
  it('самый частый уровень: при равенстве — более высокий', () => {
    expect(mostFrequentMood([{ mood: 2 }, { mood: 4 }, { mood: 4 }, { mood: 2 }])).toBe(4)
    expect(mostFrequentMood([])).toBeNull()
  })

  it('подпись клетки года и текст-альтернатива графика', () => {
    expect(dayCaption({ date: '2026-10-19', mood: 3, factor: 'work' })).toBe('19 октября — нормально · Работа')
    expect(chartAlt(2026, 10, [{ date: '2026-10-01', mood: 3, factor: null }])).toBe(
      'В октябре отмечено 1 день, чаще всего — нормально',
    )
  })

  it('график: пропуск дня разрывает линию', () => {
    const days = [1, 2, 4].map((d) => ({ date: `2026-10-0${d}`, mood: 3 as const, factor: null }))
    const chart = buildChart(2026, 10, days, { width: 300, height: 100 })
    expect(chart.segments.map((s) => s.map((p) => p.day))).toEqual([[1, 2], [4]])
  })

  it('сетка года: 12 месяцев без несуществующих дат, будущее отмечено', () => {
    const grid = buildYearGrid(2026, [{ date: '2026-02-03', mood: 5, factor: null }], '2026-10-24')
    expect(grid.map((row) => row.length)).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    expect(grid[1]![2]!.entry?.mood).toBe(5)
    expect(grid[10]![0]!.future).toBe(true)
    expect(grid[9]![23]!.future).toBe(false)
  })

  it('неделя начинается с понедельника; мост после «тяжело» и «так себе»', () => {
    expect(weekStartOf('2026-10-24')).toBe('2026-10-19')
    expect(weekStartOf('2026-10-19')).toBe('2026-10-19')
    expect(bridgeFor(3, 0)).toBeNull()
    expect(bridgeFor(2, 1)).toBe('talk')
    expect(bridgeFor(1, 3)).toBe('hard-streak')
  })
})
