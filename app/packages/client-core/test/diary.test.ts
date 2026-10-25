import { describe, expect, it } from 'vitest'
import {
  bridgeFor,
  buildChart,
  buildRollingChart,
  buildYearGrid,
  CHART_MIN_SLOTS,
  chartAlt,
  dayCaption,
  daysBetween,
  isoWeekday,
  moodInsight,
  mostFrequentMood,
  weekdayLetter,
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

const entry = (date: string, mood: 1 | 2 | 3 | 4 | 5, factor: 'work' | 'sleep' | 'people' | null = null) => ({ date, mood, factor })
const SIZE = { width: 330, height: 150 }

describe('скользящий график (28 дней)', () => {
  it('день недели и буквы под осью: П В С Ч П С В', () => {
    expect(isoWeekday('2026-10-19')).toBe(1)
    expect(isoWeekday('2026-10-25')).toBe(7)
    expect(['19', '20', '21', '22', '23', '24', '25'].map((d) => weekdayLetter(`2026-10-${d}`)).join('')).toBe('ПВСЧПСВ')
    expect(daysBetween('2026-09-28', '2026-10-25')).toBe(27)
  })

  it('без отметок: окно из 7 колонок, точек нет, подпись — месяц сегодняшнего дня', () => {
    const chart = buildRollingChart([], '2026-10-25', SIZE)
    expect(chart.slots).toBe(CHART_MIN_SLOTS)
    expect(chart.start).toBe('2026-10-25')
    expect(chart.points).toEqual([])
    expect(chart.linePath).toBe('')
    expect(chart.header).toBe('октябрь')
    // Only today has a label: the days to come have none.
    expect(chart.labels.map((l) => l.date)).toEqual(['2026-10-25'])
    expect(chart.labels[0]).toMatchObject({ isToday: true, letter: 'В', day: 25, showDay: true })
  })

  it('окно начинается с первой отметки; свободные колонки справа; суббота и воскресенье затенены, в том числе впереди', () => {
    const chart = buildRollingChart([entry('2026-10-24', 4), entry('2026-10-25', 2)], '2026-10-25', SIZE)
    expect(chart.slots).toBe(7)
    expect(chart.start).toBe('2026-10-24')
    expect(chart.points.map((p) => [p.slot, p.mood, p.isToday])).toEqual([
      [0, 4, false],
      [1, 2, true],
    ])
    expect(chart.columns.map((c) => [c.date, c.weekend, c.future])).toEqual([
      ['2026-10-24', true, false],
      ['2026-10-25', true, false],
      ['2026-10-26', false, true],
      ['2026-10-27', false, true],
      ['2026-10-28', false, true],
      ['2026-10-29', false, true],
      ['2026-10-30', false, true],
    ])
    // x is the centre of the column; two points are one column apart.
    const step = chart.columns[0]!.width
    expect(chart.points[1]!.x - chart.points[0]!.x).toBeCloseTo(step, 5)
    expect(chart.points[0]!.x).toBeCloseTo(chart.columns[0]!.x + step / 2, 5)
    // Higher mood is higher on the screen.
    expect(chart.points[0]!.y).toBeLessThan(chart.points[1]!.y)
    expect(chart.linePath.startsWith('M')).toBe(true)
    expect(chart.areaPath.endsWith('Z')).toBe(true)
  })

  it('неделя из семи отметок — ровно семь колонок; все подписаны', () => {
    const days = ['19', '20', '21', '22', '23', '24', '25'].map((d) => entry(`2026-10-${d}`, 3))
    const chart = buildRollingChart(days, '2026-10-25', SIZE)
    expect(chart.slots).toBe(7)
    expect(chart.labels.every((l) => l.showDay)).toBe(true)
    expect(chart.labels.map((l) => l.letter).join('')).toBe('ПВСЧПСВ')
  })

  it('28 дней: окно через границу месяца, подпись из двух месяцев, число под осью через одно, у сегодня всегда', () => {
    const marks = [entry('2026-09-20', 1), entry('2026-09-28', 2), entry('2026-10-10', 5), entry('2026-10-25', 3)]
    const chart = buildRollingChart(marks, '2026-10-25', SIZE)
    // 20 Sep is older than 28 days before 25 Oct (28 Sep is the first day of the window) and is not drawn.
    expect(chart.start).toBe('2026-09-28')
    expect(chart.slots).toBe(28)
    expect(chart.points.map((p) => p.date)).toEqual(['2026-09-28', '2026-10-10', '2026-10-25'])
    expect(chart.header).toBe('сентябрь · октябрь')
    const shown = chart.labels.filter((l) => l.showDay).map((l) => l.day)
    expect(shown.slice(0, 4)).toEqual([28, 30, 2, 4])
    expect(shown[shown.length - 1]).toBe(25)
    // The number before today's circle is dropped so the two do not touch.
    expect(chart.labels.find((l) => l.day === 24)!.showDay).toBe(false)
  })

  it('пропуск дня не рвёт линию, а кривая не выходит за уровни 1–5', () => {
    const marks = [entry('2026-10-19', 1), entry('2026-10-21', 5), entry('2026-10-22', 1), entry('2026-10-25', 5)]
    const chart = buildRollingChart(marks, '2026-10-25', SIZE)
    expect((chart.linePath.match(/C/g) ?? []).length).toBe(3)
    const ys = [...chart.linePath.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]))
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(chart.moodY(5) - 0.01)
    expect(Math.max(...ys)).toBeLessThanOrEqual(chart.moodY(1) + 0.01)
  })

  it('отметка из будущего и старше 28 дней в окно не попадает', () => {
    const chart = buildRollingChart([entry('2026-09-01', 1), entry('2026-10-26', 5), entry('2026-10-25', 3)], '2026-10-25', SIZE)
    expect(chart.points.map((p) => p.date)).toEqual(['2026-10-25'])
  })
})

describe('подсказка под графиком', () => {
  it('самый частый фактор тяжёлых дней: «5 из 8» в формулировке конкурента', () => {
    const heavy = [
      ...Array.from({ length: 5 }, (_, i) => entry(`2026-10-0${i + 1}`, 2, 'work')),
      entry('2026-10-06', 1, 'sleep'),
      entry('2026-10-07', 1),
      entry('2026-10-08', 2, 'people'),
      entry('2026-10-09', 5, 'people'),
    ]
    expect(moodInsight(heavy)).toBe('Тяжёлые дни чаще всего связаны с темой «работа» (5 из 8).')
  })

  it('меньше трёх тяжёлых дней или фактор реже двух раз — подсказки нет', () => {
    expect(moodInsight([entry('2026-10-01', 1, 'work'), entry('2026-10-02', 2, 'work')])).toBeNull()
    expect(moodInsight([entry('2026-10-01', 1, 'work'), entry('2026-10-02', 2, 'sleep'), entry('2026-10-03', 1, 'people')])).toBeNull()
    expect(moodInsight([entry('2026-10-01', 4, 'work'), entry('2026-10-02', 5, 'work'), entry('2026-10-03', 3, 'work')])).toBeNull()
  })

  it('ничья: фактор, который раньше в списке карточки', () => {
    const marks = [
      entry('2026-10-01', 1, 'sleep'),
      entry('2026-10-02', 1, 'sleep'),
      entry('2026-10-03', 2, 'work'),
      entry('2026-10-04', 2, 'work'),
    ]
    expect(moodInsight(marks)).toBe('Тяжёлые дни чаще всего связаны с темой «работа» (2 из 4).')
  })
})
