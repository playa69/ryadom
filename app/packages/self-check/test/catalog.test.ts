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
      const best = t.items.map((i) => (i.reverse ? 0 : hi))
      expect(score(t, best).score, t.id).toBe(t.scoring.max)
      expect(score(t, t.items.map((i) => (i.reverse ? hi : 0))).score, t.id).toBe(0)
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
