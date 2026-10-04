/**
 * The demo journal: six finished conversations spread over the last weeks, written the way a person
 * talks, with a title (the takeaway), themes and tension before/after. Shared by demo-account.mjs
 * (creates the account) and ui-shots.mjs (restores the journal between shots that start new chats).
 *
 * The agent mock's seed endpoint (dev/agent-mock) takes the result as is and replaces the user's
 * dialogs with it; it is not part of the real agent's contract.
 */

export const ACCOUNT = { name: 'Женя', email: 'zhenya.demo@example.com', password: 'demo-Password-1' }

const at = (daysAgo, hour, minute) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
const end = (startedAt, minutes) => new Date(Date.parse(startedAt) + minutes * 60_000).toISOString()

const CONVERSATIONS = [
  {
    daysAgo: 0, hour: 8, minute: 40, minutes: 12,
    title: 'Поговорю с мамой после работы',
    themes: ['семья', 'тревога'], before: 7, after: 4,
    messages: [
      ['assistant', 'Я рядом. С чего начнём?'],
      ['user', 'Проснулся с тяжестью в груди. Вчера опять поругались с мамой по телефону.'],
      ['assistant', 'Звучит тяжело. Что из вчерашнего разговора задело сильнее всего?'],
      ['user', 'Что она сказала, будто я о ней не думаю. А я думаю постоянно, просто не знаю, как это показать.'],
      ['assistant', 'Ты думаешь о ней, но тебе не удаётся это выразить, и от этого обидно вдвойне. Похоже на то, что тебе важно, чтобы она это почувствовала.'],
      ['user', 'Да. Именно. Наверное, надо просто позвонить первым и сказать это словами.'],
      ['assistant', 'Это звучит как шаг, который ты уже сам для себя нашёл. Что поможет тебе позвонить спокойно?'],
      ['user', 'Сделаю после работы, когда успокоюсь. Не из машины.'],
    ],
  },
  {
    daysAgo: 1, hour: 22, minute: 15, minutes: 9,
    title: 'Ужин с друзьями прошёл легче, чем я ждал',
    themes: ['друзья', 'облегчение'], before: 6, after: 3,
    messages: [
      ['assistant', 'Я рядом. С чего начнём?'],
      ['user', 'Вернулся с ужина. Боялся идти, думал, что буду молчать весь вечер.'],
      ['assistant', 'И как оказалось на деле?'],
      ['user', 'Нормально. Даже смеялся. Дима рассказал про свою поездку, и я как-то втянулся.'],
      ['assistant', 'Ты ждал худшего, а вышло тепло. Что в тот момент тебя отпустило?'],
      ['user', 'Наверное, что никто ничего от меня не ждал. Можно было просто быть.'],
    ],
  },
  {
    daysAgo: 3, hour: 19, minute: 30, minutes: 14,
    title: 'Дышать медленнее — и страх уходит',
    themes: ['паника', 'дыхание'], before: 9, after: 5,
    messages: [
      ['assistant', 'Я рядом. С чего начнём?'],
      ['user', 'Накрыло в метро. Сердце колотится, кажется, что сейчас упаду.'],
      ['assistant', 'Я здесь. Ты сейчас в безопасности. Давай вместе: вдох на четыре счёта, выдох на шесть.'],
      ['user', 'Ладно. Вдох... выдох...'],
      ['assistant', 'Хорошо. Ещё раз, не торопись. Что ты видишь вокруг? Назови три предмета.'],
      ['user', 'Поручень. Синяя куртка. Реклама кофе.'],
      ['assistant', 'Ты справляешься. Сердце уже бьётся ровнее?'],
      ['user', 'Да, получше. Вышел на станции, постоял.'],
    ],
  },
  {
    daysAgo: 5, hour: 12, minute: 5, minutes: 7,
    title: 'Закрыть рабочий день и не возвращаться к нему',
    themes: ['работа', 'усталость'], before: 5, after: 3,
    messages: [
      ['assistant', 'Я рядом. С чего начнём?'],
      ['user', 'Не могу выключить голову после работы. Всё прокручиваю совещание.'],
      ['assistant', 'Похоже на усталость и тревогу одновременно. Что именно ты прокручиваешь?'],
      ['user', 'Как я запнулся на презентации. Хотя никто не заметил.'],
      ['assistant', 'Ты замечаешь свои запинки гораздо сильнее, чем остальные. Что бы ты сказал коллеге, который так же запнулся?'],
      ['user', 'Что это ерунда и он молодец. Ладно, сам себе скажу.'],
    ],
  },
  {
    daysAgo: 11, hour: 23, minute: 50, minutes: 18,
    title: 'Письмо, которое я так и не отправил',
    themes: ['отношения', 'прощение'], before: 8, after: 6,
    messages: [
      ['assistant', 'Я рядом. С чего начнём?'],
      ['user', 'Написал Лене длинное письмо. Не отправил. Не знаю, правильно ли.'],
      ['assistant', 'Что ты хотел бы, чтобы она поняла из этого письма?'],
      ['user', 'Что я не злюсь больше. И что мне жаль.'],
      ['assistant', 'Это важные слова. Иногда письмо нужно прежде всего тому, кто его пишет. Как тебе после того, как ты его написал?'],
      ['user', 'Легче. Хоть и грустно.'],
    ],
  },
  {
    daysAgo: 24, hour: 21, minute: 20, minutes: 8,
    title: 'Неделя тишины',
    themes: ['одиночество'], before: 6, after: 4,
    messages: [
      ['assistant', 'Я рядом. С чего начнём?'],
      ['user', 'Давно ни с кем толком не говорил. Заметил это только сегодня.'],
      ['assistant', 'Спасибо, что говоришь об этом вслух. Кому из близких тебе хотелось бы написать первым?'],
      ['user', 'Брату. Он давно спрашивал, как дела.'],
    ],
  },
]

const SEED = CONVERSATIONS.map((c) => {
  const startedAt = at(c.daysAgo, c.hour, c.minute)
  return {
    mode: 'vent',
    startedAt,
    endedAt: end(startedAt, c.minutes),
    summary: { title: c.title, themes: c.themes, tensionBefore: c.before, tensionAfter: c.after },
    messages: c.messages.map(([role, text]) => ({ role, text })),
  }
})


/** Replaces the dialogs of `userId` in the agent mock at `agent` with the demo journal. */
export async function seedJournal(agent, userId) {
  const base = agent.replace(/\/+$/, '')
  const response = await fetch(`${base}/v1/users/${encodeURIComponent(userId)}/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dialogs: SEED }),
  })
  if (!response.ok) throw new Error(`seed failed: ${response.status} ${await response.text()}`)
  return SEED.length
}
