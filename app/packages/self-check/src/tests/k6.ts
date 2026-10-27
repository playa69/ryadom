import type { SelfCheckTest } from '../types'

// Kessler Psychological Distress Scale, K6 (Kessler и др., 2003). Harvard NCS: free, no formal permission needed, but the
// copyright of R. C. Kessler must be shown and the article cited (both on the result screen); translating is allowed.
// Russian wording is our own, in the app's «ты» and free of gendered forms. Commercial use is not addressed there.
export const k6: SelfCheckTest = {
  id: 'k6', version: 1, code: 'K6',
  title: 'Общее напряжение', subtitle: 'K6', icon: 'zap',
  preface: 'Как часто за последние 30 дней с тобой было так?',
  options: [
    { label: 'Никогда', value: 0 },
    { label: 'Редко', value: 1 },
    { label: 'Иногда', value: 2 },
    { label: 'Часто', value: 3 },
    { label: 'Всё время', value: 4 },
  ],
  items: [
    { text: 'Тебя охватывала нервозность' },
    { text: 'Тебя охватывала безнадёжность' },
    { text: 'Тебе было неспокойно, не получалось усидеть на месте' },
    { text: 'Тебе было так грустно, что ничто не могло подбодрить' },
    { text: 'Всё давалось с трудом' },
    { text: 'Возникало чувство собственной никчёмности' },
  ],
  scoring: { kind: 'sum', max: 24 },
  bands: [
    { from: 0, to: 4, label: 'низкий уровень напряжения', tone: 'calm', text: 'Общее напряжение сейчас невысокое.' },
    { from: 5, to: 12, label: 'умеренный уровень напряжения', tone: 'mild', text: 'Напряжение заметно. Присмотрись к тому, что его даёт, и найди время восстановиться.' },
    { from: 13, to: 24, label: 'высокий уровень напряжения', tone: 'high', text: 'Напряжение высокое. Стоит поговорить об этом с близкими или со специалистом.' },
  ],
  highBandFrom: 13,
  source: '© Ronald C. Kessler. Kessler и др., 2003 (Archives of General Psychiatry, 60, 184–189); русская версия — наш перевод',
  license: 'Свободно, без формального разрешения; обязательны авторское право Р. Кесслера и ссылка на статью; перевод разрешён (Harvard NCS)',
}
