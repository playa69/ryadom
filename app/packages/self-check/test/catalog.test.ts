import { describe, expect, it } from 'vitest'
import { allTests, byId, wave1 } from '../src/catalog'
import { score } from '../src/score'

describe('волна 1', () => {
  it('у каждого теста бандами покрыт весь диапазон баллов', () => {
    for (const t of wave1) {
      for (let v = 0; v <= t.scoring.max; v++) {
        expect(t.bands.some((b) => v >= b.from && v <= b.to), `${t.id}: ${v}`).toBe(true)
      }
    }
  })
  it('максимум и минимум совпадают с описанием', () => {
    for (const t of wave1) {
      const hi = Math.max(...t.options.map((o) => o.value))
      const best = t.items.map((i) => (i.reverse ? 0 : hi))
      expect(score(t, best).score, t.id).toBe(t.scoring.max)
      expect(score(t, t.items.map((i) => (i.reverse ? hi : 0))).score, t.id).toBe(0)
    }
  })
  it('PHQ-9: кризисный только пункт 9', () => {
    expect(byId('phq9')!.items.map((i) => !!i.crisis)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1].map(Boolean))
  })
  it('в подписях нет диагнозов', () => {
    for (const t of wave1) for (const b of t.bands) expect(b.label + b.text).not.toMatch(/депресси|расстройств|диагноз:/i)
  })
})

import { miniIpip } from '../src/tests/miniipip'
import { wave2 } from '../src/catalog'

describe('Mini-IPIP', () => {
  it('обратные пункты считаются как 6 − ответ', () => {
    const a = miniIpip.items.map((i) => (i.reverse ? 1 : 5))
    const r = score(miniIpip, a)
    expect(r.subscales.map((s) => s.score)).toEqual([5, 5, 5, 5, 5])
  })
  it('в каждой черте 4 пункта и всего 20', () => {
    expect(miniIpip.items).toHaveLength(20)
    expect(wave2).toContain(miniIpip)
  })
})

import { band, isHigh, retakeAfterDays } from '../src/score'

describe('повтор теста', () => {
  it('высокий уровень — через 2 недели, остальные — через 4', () => {
    const phq = byId('phq9')!
    expect(retakeAfterDays(phq, 20)).toBe(14)
    expect(retakeAfterDays(phq, 3)).toBe(28)
  })
})

describe('каталог', () => {
  it('в каталоге все одиннадцать тестов, у каждого свой id', () => {
    expect(allTests.map((t) => t.id)).toEqual(['gad7', 'phq9', 'rosenberg', 'wellbeing', 'stress', 'burnout', 'swls', 'k6', 'phq2', 'gad2', 'mini-ipip'])
    expect(new Set(allTests.map((t) => t.id)).size).toBe(allTests.length)
  })
  it('byId находит тест любой волны', () => {
    expect(byId('mini-ipip')?.code).toBe('Mini-IPIP')
  })
})

describe('PHQ-9 по спеке', () => {
  it('«сильная выраженность» и карточка специалиста от 20; 15–19 — без карточки', () => {
    const phq = byId('phq9')!
    expect(phq.highBandFrom).toBe(20)
    expect(band(phq, 21)?.label).toBe('сильная выраженность')
    expect(isHigh(phq, 21)).toBe(true)
    expect(isHigh(phq, 19)).toBe(false)
    expect(phq.items[8]?.crisis).toEqual({ from: 1 })
  })
})
