import type { Band, ScoreResult, SelfCheckTest } from './types'

const round = (n: number, digits = 2) => {
  const k = 10 ** digits
  return Math.round(n * k) / k
}

/** Наибольшее значение варианта ответа. */
const optionMax = (t: SelfCheckTest) => Math.max(...t.options.map((o) => o.value))
const optionMin = (t: SelfCheckTest) => Math.min(...t.options.map((o) => o.value))

/** Ошибка, если ответы не подходят к описанию теста. */
export function validateAnswers(t: SelfCheckTest, answers: readonly number[]): void {
  if (answers.length !== t.items.length) {
    throw new RangeError(`${t.id}: ожидалось ${t.items.length} ответов, получено ${answers.length}`)
  }
  const allowed = new Set(t.options.map((o) => o.value))
  for (const a of answers) {
    if (!allowed.has(a)) throw new RangeError(`${t.id}: недопустимый ответ ${a}`)
  }
}

/** Балл пункта с учётом обратных. */
function itemScore(t: SelfCheckTest, i: number, answer: number): number {
  return t.items[i]?.reverse ? optionMax(t) + optionMin(t) - answer : answer
}

/** Подсчёт без побочных эффектов; бросает `RangeError` на неверных ответах. */
export function score(t: SelfCheckTest, answers: readonly number[]): ScoreResult {
  validateAnswers(t, answers)
  const s = t.scoring
  const pts = answers.map((a, i) => itemScore(t, i, a))
  const sumOf = (idx: number[]) => idx.reduce((acc, i) => acc + (pts[i] ?? 0), 0)
  const all = pts.map((_, i) => i)

  let total: number
  let subscales: ScoreResult['subscales'] = []
  if (s.kind === 'sum') {
    total = sumOf(all) * (s.multiplier ?? 1)
    subscales = (s.subscales ?? []).map((sub) => ({ id: sub.id, label: sub.label, score: sumOf(sub.items) }))
  } else if (s.kind === 'mean') {
    subscales = s.subscales.map((sub) => ({
      id: sub.id,
      label: sub.label,
      score: round(sumOf(sub.items) / sub.items.length),
    }))
    total = round(sumOf(all) / pts.length)
  } else {
    const idx = s.rule.items ?? all
    total = idx.filter((i) => (answers[i] ?? 0) >= s.rule.atLeast).length
  }
  return { score: total, max: s.max, percent: Math.round((total / s.max) * 100), subscales }
}

/** Уровень по баллу; `undefined`, если балл вне порогов. */
export function band(t: SelfCheckTest, value: number): Band | undefined {
  return t.bands.find((b) => value >= b.from && value <= b.to)
}

/** Нужна ли карточка «Поговорить со специалистом». */
export function isHigh(t: SelfCheckTest, value: number): boolean {
  return t.highBandFrom !== undefined && value >= t.highBandFrom
}

/** Номера кризисных пунктов, на которые дан ответ от порога `crisis.from` и выше (от нуля). */
export function crisisTriggered(t: SelfCheckTest, answers: readonly number[]): number[] {
  const hit: number[] = []
  t.items.forEach((it, i) => {
    if (it.crisis && (answers[i] ?? -Infinity) >= it.crisis.from) hit.push(i)
  })
  return hit
}

/** Есть ли кризисный ответ: экран помощи показывается после последнего вопроса, до результата. */
export function hasCrisisAnswer(t: SelfCheckTest, answers: readonly number[]): boolean {
  return crisisTriggered(t, answers).length > 0
}

/**
 * Через сколько дней предложить повторить тест: при высоком уровне — через 2 недели
 * (окно вопросов PHQ-9 и GAD-7), иначе через 4 недели. Ориентир из практики скринингов
 * Mental Health America; пересмотреть с психологом (подзадача 0.4).
 */
export function retakeAfterDays(t: SelfCheckTest, value: number): number {
  return isHigh(t, value) ? 14 : 28
}
