import type { SelfCheckTest } from '../types'
import { gad7 } from './gad7'
import { phq9 } from './phq9'

const FREQ = phq9.options

/**
 * PHQ-2 and GAD-2: the first two questions of PHQ-9 and GAD-7, the same wording (Pfizer, free to reproduce).
 * A quick way in: at 3 and above the full test is offered.
 */
export const phq2: SelfCheckTest = {
  id: 'phq2', version: 1, code: 'PHQ-2',
  title: 'Подавленность: быстрый вопрос', subtitle: 'PHQ-2', icon: 'cloud-rain',
  preface: phq9.preface,
  options: FREQ,
  items: phq9.items.slice(0, 2),
  scoring: { kind: 'sum', max: 6 },
  bands: [
    { from: 0, to: 2, label: 'ниже порога', tone: 'calm', text: 'По двум вопросам признаков немного. Если хочется разобраться подробнее, пройди полный тест «Подавленность».' },
    { from: 3, to: 6, label: 'от порога', tone: 'moderate', text: 'Стоит пройти полный тест «Подавленность»: он покажет картину подробнее.' },
  ],
  source: phq9.source,
  license: phq9.license,
  status: 'review',
}

export const gad2: SelfCheckTest = {
  id: 'gad2', version: 1, code: 'GAD-2',
  title: 'Тревога: быстрый вопрос', subtitle: 'GAD-2', icon: 'wind',
  preface: gad7.preface,
  options: FREQ,
  items: gad7.items.slice(0, 2),
  scoring: { kind: 'sum', max: 6 },
  bands: [
    { from: 0, to: 2, label: 'ниже порога', tone: 'calm', text: 'По двум вопросам признаков немного. Если хочется разобраться подробнее, пройди полный тест «Тревога».' },
    { from: 3, to: 6, label: 'от порога', tone: 'moderate', text: 'Стоит пройти полный тест «Тревога»: он покажет картину подробнее.' },
  ],
  source: gad7.source,
  license: gad7.license,
  status: 'review',
}
