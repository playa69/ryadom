import { describe, expect, it } from 'vitest'
import { band, crisisTriggered, hasCrisisAnswer, isHigh, score } from '../src/score'
import type { SelfCheckTest } from '../src/types'

const opts = (n: number) => Array.from({ length: n }, (_, v) => ({ label: String(v), value: v }))
const items = (n: number, reverse: number[] = [], crisis: number[] = []) =>
  Array.from({ length: n }, (_, i) => ({ text: `q${i + 1}`, reverse: reverse.includes(i), crisis: crisis.includes(i) ? { from: 1 } : undefined }))
const base = { version: 1, code: 'T', title: 'T', subtitle: '', icon: 'x', preface: '', source: '', license: '', status: 'review' as const }

const who5: SelfCheckTest = {
  ...base, id: 'who5', options: opts(6), items: items(5),
  scoring: { kind: 'sum', max: 25 },
  bands: [{ from: 0, to: 12, label: 'низкий', tone: 'high', text: '' }, { from: 13, to: 25, label: 'норма', tone: 'calm', text: '' }],
}
const rosenberg: SelfCheckTest = {
  ...base, id: 'rosenberg', options: opts(4), items: items(10, [1, 4, 5, 7, 8]),
  scoring: { kind: 'sum', max: 30 }, bands: [{ from: 0, to: 30, label: 'ориентир', tone: 'calm', text: '' }],
}
const phq9: SelfCheckTest = {
  ...base, id: 'phq9', options: opts(4), items: items(9, [], [8]),
  scoring: { kind: 'sum', max: 27 }, highBandFrom: 20,
  bands: [{ from: 0, to: 4, label: 'минимальная', tone: 'calm', text: '' }, { from: 20, to: 27, label: 'выраженная', tone: 'high', text: '' }],
}

describe('score', () => {
  it('WHO-5: 3,3,3,3,3 → 15 из 25, 60%', () => {
    const r = score(who5, [3, 3, 3, 3, 3])
    expect(r).toMatchObject({ score: 15, max: 25, percent: 60 })
  })
  it('Розенберг: обратные пункты 2,5,6,8,9 → максимум 30', () => {
    const a = Array.from({ length: 10 }, (_, i) => ([1, 4, 5, 7, 8].includes(i) ? 0 : 3))
    expect(score(rosenberg, a).score).toBe(30)
  })
  it('множитель и подшкалы', () => {
    const t: SelfCheckTest = { ...who5, scoring: { kind: 'sum', multiplier: 2, max: 50, subscales: [{ id: 'a', label: 'A', items: [0, 1] }] } }
    const r = score(t, [1, 2, 3, 4, 5])
    expect(r.score).toBe(30)
    expect(r.subscales).toEqual([{ id: 'a', label: 'A', score: 3 }])
  })
  it('среднее по подшкалам', () => {
    const t: SelfCheckTest = { ...who5, scoring: { kind: 'mean', max: 5, subscales: [{ id: 'a', label: 'A', items: [0, 1] }, { id: 'b', label: 'B', items: [2, 3, 4] }] } }
    const r = score(t, [1, 2, 3, 4, 5])
    expect(r.subscales.map((s) => s.score)).toEqual([1.5, 4])
    expect(r.score).toBe(3)
  })
  it('засчитывание: считаются ответы не ниже порога', () => {
    const t: SelfCheckTest = { ...who5, scoring: { kind: 'count', rule: { atLeast: 3 }, max: 5 } }
    expect(score(t, [3, 2, 4, 5, 0]).score).toBe(3)
  })
  it('не меняет входные данные и бросает на неверных ответах', () => {
    const a = [1, 1, 1, 1, 1]
    score(who5, a)
    expect(a).toEqual([1, 1, 1, 1, 1])
    expect(() => score(who5, [1, 1])).toThrow(RangeError)
    expect(() => score(who5, [1, 1, 1, 1, 9])).toThrow(RangeError)
  })
})

describe('band / crisis', () => {
  it('уровень по баллу и вне порогов', () => {
    expect(band(who5, 15)?.label).toBe('норма')
    expect(band(phq9, 10)).toBeUndefined()
  })
  it('высокий уровень', () => {
    expect(isHigh(phq9, 20)).toBe(true)
    expect(isHigh(phq9, 19)).toBe(false)
    expect(isHigh(who5, 25)).toBe(false)
  })
  it('PHQ-9, пункт 9: ненулевой ответ — кризис', () => {
    expect(hasCrisisAnswer(phq9, [0, 0, 0, 0, 0, 0, 0, 0, 1])).toBe(true)
    expect(hasCrisisAnswer(phq9, [3, 3, 3, 3, 3, 3, 3, 3, 0])).toBe(false)
  })
})

describe('crisis { from }', () => {
  it('порог from: ответ ниже — нет, от порога и выше — да, номера сработавших пунктов', () => {
    const t: SelfCheckTest = { ...phq9, items: phq9.items.map((it, i) => (i === 0 ? { ...it, crisis: { from: 3 } } : it)) }
    expect(crisisTriggered(t, [2, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual([])
    expect(crisisTriggered(t, [3, 0, 0, 0, 0, 0, 0, 0, 1])).toEqual([0, 8])
  })
})
