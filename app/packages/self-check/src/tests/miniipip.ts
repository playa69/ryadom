import type { SelfCheckTest } from '../types'

// Mini-IPIP (Donnellan и др., 2006), пункты из IPIP (ipip.ori.org, общественное достояние).
// Русские формулировки — наш перевод, ждёт ревью; порядок пунктов как в оригинале.
export const miniIpip: SelfCheckTest = {
  id: 'mini-ipip', version: 1, code: 'Mini-IPIP',
  title: 'Пять черт личности', subtitle: 'Mini-IPIP · 20 вопросов · ~4 мин', icon: 'sparkles',
  preface: 'Насколько каждое утверждение подходит тебе в целом?',
  options: [
    { label: 'Совсем не подходит', value: 1 },
    { label: 'Скорее не подходит', value: 2 },
    { label: 'Затрудняюсь ответить', value: 3 },
    { label: 'Скорее подходит', value: 4 },
    { label: 'Полностью подходит', value: 5 },
  ],
  items: [
    { text: 'Я — душа компании' },
    { text: 'Я сочувствую чувствам других людей' },
    { text: 'Я сразу же делаю домашние дела' },
    { text: 'У меня часто меняется настроение' },
    { text: 'У меня яркое воображение' },
    { text: 'Я мало говорю', reverse: true },
    { text: 'Чужие проблемы мне не интересны', reverse: true },
    { text: 'Я часто забываю класть вещи на место', reverse: true },
    { text: 'Большую часть времени я спокоен', reverse: true },
    { text: 'Мне трудно понимать абстрактные идеи', reverse: true },
    { text: 'На вечеринках я разговариваю со многими разными людьми' },
    { text: 'Я чувствую эмоции других людей' },
    { text: 'Я люблю порядок' },
    { text: 'Я легко расстраиваюсь' },
    { text: 'Мне неинтересны абстрактные идеи', reverse: true },
    { text: 'Я держусь в стороне', reverse: true },
    { text: 'Другие люди мне, по сути, неинтересны', reverse: true },
    { text: 'Я устраиваю беспорядок', reverse: true },
    { text: 'Мне редко бывает грустно', reverse: true },
    { text: 'У меня плохое воображение', reverse: true },
  ],
  scoring: {
    kind: 'mean', max: 5,
    subscales: [
      { id: 'extraversion', label: 'Экстраверсия', items: [0, 5, 10, 15] },
      { id: 'agreeableness', label: 'Доброжелательность', items: [1, 6, 11, 16] },
      { id: 'conscientiousness', label: 'Добросовестность', items: [2, 7, 12, 17] },
      { id: 'neuroticism', label: 'Эмоциональная неустойчивость', items: [3, 8, 13, 18] },
      { id: 'openness', label: 'Открытость опыту', items: [4, 9, 14, 19] },
    ],
  },
  // Общего уровня у профиля нет: результат — пять средних по чертам, показываем их, а не итог.
  bands: [{ from: 0, to: 5, label: 'профиль черт', tone: 'calm', text: 'Черты не хорошие и не плохие: это описание того, как ты обычно ведёшь себя. Сравнивай себя с собой в разное время, а не с другими.' }],
  source: 'Donnellan, Oswald, Baird, Lucas, 2006; пункты IPIP (Goldberg); перевод Рядом',
  license: 'IPIP: свободно для любых целей, в том числе коммерческих',
  status: 'review',
}
