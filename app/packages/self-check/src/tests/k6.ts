import type { SelfCheckTest } from '../types'

// Kessler Psychological Distress Scale, K6 (Kessler и др., 2003). Harvard NCS: free, no formal permission needed,
// keep the notice and cite the article. Russian wording is our own translation, awaiting review (status review).
export const k6: SelfCheckTest = {
  id: 'k6', version: 1, code: 'K6',
  title: 'Общее напряжение', subtitle: 'K6', icon: 'zap',
  preface: 'Как часто за последние 30 дней вы чувствовали, что…',
  options: [
    { label: 'Никогда', value: 0 },
    { label: 'Редко', value: 1 },
    { label: 'Иногда', value: 2 },
    { label: 'Часто', value: 3 },
    { label: 'Всё время', value: 4 },
  ],
  items: [
    { text: 'Вы нервничали' },
    { text: 'Вы чувствовали безнадёжность' },
    { text: 'Вы чувствовали беспокойство и не могли усидеть на месте' },
    { text: 'Вам было так грустно, что ничто не могло вас взбодрить' },
    { text: 'Всё давалось вам с трудом' },
    { text: 'Вы чувствовали себя никчёмным' },
  ],
  scoring: { kind: 'sum', max: 24 },
  bands: [
    { from: 0, to: 4, label: 'низкий уровень напряжения', tone: 'calm', text: 'Общее напряжение сейчас невысокое.' },
    { from: 5, to: 12, label: 'умеренный уровень напряжения', tone: 'mild', text: 'Напряжение заметно. Присмотрись к тому, что его даёт, и найди время восстановиться.' },
    { from: 13, to: 24, label: 'высокий уровень напряжения', tone: 'high', text: 'Напряжение высокое. Стоит поговорить об этом с близкими или со специалистом.' },
  ],
  highBandFrom: 13,
  source: 'Kessler и др., 2003 (Archives of General Psychiatry); русская версия — наш перевод',
  license: 'Свободно, без формального разрешения, с цитированием статьи и сохранением уведомления (Harvard NCS)',
  status: 'review',
}
