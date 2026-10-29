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

describe('указание авторов', () => {
  it('у каждого теста есть источник, который показывается на экране результата', () => {
    for (const t of allTests) expect(t.source.trim().length, t.id).toBeGreaterThan(0)
  })
  it('SWLS называет всех четырёх авторов, K6 — авторское право Кесслера и статью', () => {
    const swls = byId('swls')!.source
    for (const name of ['Diener', 'Emmons', 'Larsen', 'Griffin']) expect(swls).toContain(name)
    const k6 = byId('k6')!.source
    expect(k6).toContain('© Ronald C. Kessler')
    expect(k6).toContain('Archives of General Psychiatry')
  })
  it('в собственных переводах нет обращения на «вы» и родовых окончаний', () => {
    for (const id of ['swls', 'k6']) {
      const t = byId(id)!
      const text = [t.preface, ...t.items.map((i) => i.text), ...t.options.map((o) => o.label), ...t.bands.map((b) => b.text)].join(' ')
      expect(text, id).not.toMatch(/\b[Вв]ы\b|\b[Вв]ам\b|\b[Вв]ас\b/)
      expect(text, id).not.toMatch(/(?:^|\s)(?:доволен|согласен|получил|хотел|нервничал)(?=[\s.,])/i)
    }
  })
})

describe('подсчёт SWLS, K6, PHQ-2 и GAD-2', () => {
  const allAnswers = (id: string, pick: 'lo' | 'hi') => {
    const t = byId(id)!
    const values = t.options.map((o) => o.value)
    const v = pick === 'hi' ? Math.max(...values) : Math.min(...values)
    return t.items.map(() => v)
  }
  it('минимум и максимум совпадают с описанием, а подписи покрывают весь диапазон', () => {
    for (const [id, min, max] of [['swls', 5, 35], ['k6', 0, 24], ['phq2', 0, 6], ['gad2', 0, 6]] as const) {
      const t = byId(id)!
      expect(score(t, allAnswers(id, 'lo')).score, id).toBe(min)
      expect(score(t, allAnswers(id, 'hi')).score, id).toBe(max)
      expect(t.scoring.max, id).toBe(max)
      for (let v = min; v <= max; v++) expect(band(t, v), `${id}: ${v}`).toBeDefined()
    }
  })
  it('SWLS: 20 — нейтрально, K6: от 13 — высокий уровень, быстрые тесты — порог на 3', () => {
    expect(band(byId('swls')!, 20)?.label).toBe('ориентир: нейтрально')
    expect(isHigh(byId('k6')!, 13)).toBe(true)
    expect(isHigh(byId('k6')!, 12)).toBe(false)
    for (const id of ['phq2', 'gad2']) {
      expect(band(byId(id)!, 2)?.label, id).toBe('ниже порога')
      expect(band(byId(id)!, 3)?.label, id).toBe('от порога')
    }
  })
})
