/** Тон уровня: цвет сегмента шкалы и точки в списках. */
export type Tone = 'calm' | 'mild' | 'moderate' | 'high'

export type Option = { label: string; value: number }

export type Item = {
  text: string
  /** Обратный пункт: балл ответа считается как `min + max - value`. */
  reverse?: boolean
  /** Ответ от `from` и выше открывает экран помощи после последнего вопроса (PHQ-9, пункт 9: от 1). */
  crisis?: { from: number }
}

export type Subscale = { id: string; label: string; items: number[] }

/** Правило засчитывания: пункт идёт в счёт, если ответ не меньше `atLeast`. */
export type CountRule = { atLeast: number; items?: number[] }

export type Scoring =
  | { kind: 'sum'; multiplier?: number; max: number; subscales?: Subscale[] }
  | { kind: 'mean'; max: number; subscales: Subscale[] }
  | { kind: 'count'; rule: CountRule; max: number }

export type Band = {
  from: number
  to: number
  label: string
  tone: Tone
  text: string
}

export type SelfCheckTest = {
  id: string
  version: number
  code: string
  title: string
  subtitle: string
  icon: string
  preface: string
  options: Option[]
  items: Item[]
  scoring: Scoring
  bands: Band[]
  highBandFrom?: number
  source: string
  license: string
}

export type SubscaleScore = { id: string; label: string; score: number }

export type ScoreResult = {
  score: number
  max: number
  /** Процент от максимума, 0–100, округлён. */
  percent: number
  subscales: SubscaleScore[]
}
