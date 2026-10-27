import type { SelfCheckTest } from '@ryadom/self-check/types'

export const TONE_COLOR = { calm: '#4cc38a', mild: '#e6c84f', moderate: '#f0903a', high: '#e5484d' } as const

export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1]
  return forms[2]
}

/** «9 вопросов · ~3 мин» — the length line of a row and of the sheet header. */
export function lengthLine(t: SelfCheckTest): string {
  const minutes = Math.max(1, Math.round(t.items.length / 3))
  return `${t.code} · ${t.items.length} ${plural(t.items.length, ['вопрос', 'вопроса', 'вопросов'])} · ~${minutes} мин`
}

export const DISCLAIMER =
  'Это скрининговый опросник, а не диагноз. Если результат тебя беспокоит — обсуди его со специалистом.'
