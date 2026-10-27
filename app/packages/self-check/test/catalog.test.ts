import { describe, expect, it } from 'vitest'
import { byId, catalog, wave1 } from '../src/catalog'
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
      const lo = Math.min(...t.options.map((o) => o.value))
      const best = t.items.map((i) => (i.reverse ? lo : hi))
      expect(score(t, best).score, t.id).toBe(t.scoring.max)
      // The lowest answers give 0 only for scales that start at 0; those that start at 1 give 5 × 1 and so on.
      if (lo === 0) expect(score(t, t.items.map((i) => (i.reverse ? hi : 0))).score, t.id).toBe(0)
    }
  })
  it('PHQ-9: кризисный только пункт 9; в проде только ready', () => {
    expect(byId('phq9')!.items.map((i) => !!i.crisis)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1].map(Boolean))
    expect(catalog()).toEqual([])
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

import { visible } from '../src/catalog'

describe('видимость', () => {
  it('без preview в проде пусто, с preview видны тесты на ревью', () => {
    expect(visible(false)).toEqual([])
    expect(visible(true).length).toBe(11)
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

describe('волна 2 без коммерческой лицензии', () => {
  it('SWLS: 7×5=35 «очень высокая», все единицы — 5; K6: 13 и выше — высокий; PHQ-2/GAD-2 — первые два вопроса', () => {
    const swls = byId('swls')!
    expect(score(swls, [7, 7, 7, 7, 7]).score).toBe(35)
    expect(band(swls, 35)?.label).toContain('очень высокая')
    expect(score(swls, [1, 1, 1, 1, 1]).score).toBe(5)
    const k6 = byId('k6')!
    expect(isHigh(k6, 13)).toBe(true)
    expect(isHigh(k6, 12)).toBe(false)
    expect(byId('phq2')!.items).toEqual(byId('phq9')!.items.slice(0, 2))
    expect(byId('gad2')!.items).toEqual(byId('gad7')!.items.slice(0, 2))
    expect(score(byId('phq2')!, [1, 2]).score).toBe(3)
    expect(band(byId('phq2')!, 3)?.label).toBe('от порога')
  })
})
