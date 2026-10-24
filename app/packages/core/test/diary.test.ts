/**
 * The mood diary on the real core and database (`REQ-WELL-01`, `openspec/changes/add-mood-diary`):
 * the local day, one note a day, the week and year summaries the agent writes and the app keeps.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { diarySummaries, moodCheckins, users } from '@ryadom/db/schema'
import {
  CreateWeekSummaryOperation,
  CreateYearStoryOperation,
  DiaryOperationErrorCode,
  diaryProcess,
  GetDiaryEventsOperation,
  GetDiaryOperation,
  GetYearOperation,
  PutMoodCheckinOperation,
  RunWeeklyDigestsOperation,
} from '../src/processes/diary'
import { getDb } from '../src/shared'
import { json, mockFetch, registerConfirmedUser } from './helpers'

/** Saturday 24 Oct 2026, 12:00 in Moscow; the week starts on Monday the 19th. */
const NOW = new Date('2026-10-24T09:00:00Z')

const digestRoute = () =>
  json({ text: 'Спасибо, что ты рядом с собой на этой неделе.', stats: { markedDays: 3 } })

async function mark(userId: string, localDate: string, mood = 3, factor: 'work' | null = null) {
  await getDb().insert(moodCheckins).values({ userId, localDate, mood, factor, source: 'app' })
}

const put = (userId: string, over: Partial<ConstructorParameters<typeof PutMoodCheckinOperation>[0]> = {}) =>
  diaryProcess.execute(new PutMoodCheckinOperation({ userId, mood: 3, source: 'app', now: NOW, ...over }))

describe('отметка настроения', () => {
  it('два касания: уровень, затем фактор; повторный выбор заменяет уровень и оставляет фактор', async () => {
    const user = await registerConfirmedUser()
    const first = await put(user.id, { mood: 3 })
    expect(first).toMatchObject({ success: true, changed: false, checkin: { date: '2026-10-24', mood: 3, factor: null } })

    const withFactor = await put(user.id, { mood: 3, factor: 'work' })
    expect(withFactor).toMatchObject({ success: true, changed: true, checkin: { factor: 'work' } })

    // «Передумал»: another level, no factor in the request — the factor stays, one note for the day.
    const changed = await put(user.id, { mood: 4 })
    expect(changed).toMatchObject({ success: true, changed: true, checkin: { mood: 4, factor: 'work' } })

    // The factor can be taken off: null clears it.
    expect(await put(user.id, { mood: 4, factor: null })).toMatchObject({ checkin: { factor: null } })
    const rows = await getDb().select().from(moodCheckins).where(eq(moodCheckins.userId, user.id))
    expect(rows).toHaveLength(1)
  })

  it('день — местный: во Владивостоке в 00:30 это уже следующая дата, а не московская', async () => {
    const user = await registerConfirmedUser()
    await getDb().update(users).set({ timezone: 'Asia/Vladivostok' }).where(eq(users.id, user.id))
    const result = await put(user.id, { now: new Date('2026-10-23T14:30:00Z') })
    expect(result).toMatchObject({ success: true, checkin: { date: '2026-10-24' } })
  })

  it('дата от клиента: сегодня или вчера (очередь без сети), иначе отказ', async () => {
    const user = await registerConfirmedUser()
    expect(await put(user.id, { date: '2026-10-23' })).toMatchObject({ success: true, checkin: { date: '2026-10-23' } })
    for (const date of ['2026-10-22', '2026-10-25', '2026-02-30', 'вчера']) {
      expect(await put(user.id, { date })).toEqual({ success: false, error: DiaryOperationErrorCode.DATE_OUT_OF_RANGE })
    }
  })

  it('мост к разговору: подряд идущие «тяжело» считаются сервером', async () => {
    const user = await registerConfirmedUser()
    await mark(user.id, '2026-10-22', 1)
    await mark(user.id, '2026-10-23', 1)
    expect(await put(user.id, { mood: 1 })).toMatchObject({ success: true, hardStreak: 3 })
    expect(await put(user.id, { mood: 2 })).toMatchObject({ success: true, hardStreak: 0 })
  })
})

describe('экран дневника', () => {
  it('отдаёт сегодняшнюю отметку, месяц, неделю и настройку напоминания по умолчанию', async () => {
    const user = await registerConfirmedUser()
    await mark(user.id, '2026-10-19', 2)
    await put(user.id, { mood: 4, factor: 'sleep' })
    const view = await diaryProcess.execute(new GetDiaryOperation({ userId: user.id, now: NOW }))
    if (!view.success) throw new Error('refused')
    expect(view.diary.today).toMatchObject({ date: '2026-10-24', mood: 4, factor: 'sleep' })
    expect(view.diary.month.map((d) => d.date)).toEqual(['2026-10-19', '2026-10-24'])
    expect(view.diary.week).toMatchObject({ start: '2026-10-19', markedDays: 2, summary: null })
    expect(view.diary.reminder).toEqual({ enabled: true, time: '20:00', paused: false, offerAnswered: false })
  })

  it('«События этой недели»: память включена — пустой список; агент недоступен — не ошибка', async () => {
    const user = await registerConfirmedUser()
    mockFetch({
      'GET http://agent.test/v1/users/*/memory': () => json({ available: true, mode: 'on', enabled: false, consentVersion: null, consentAt: null, rulesVersion: '1', limits: { maxFacts: 50 }, facts: [] }),
    })
    expect(await diaryProcess.execute(new GetDiaryEventsOperation({ userId: user.id }))).toEqual({
      success: true,
      memoryEnabled: false,
      events: [],
    })
  })
})

describe('итоги недели', () => {
  it('меньше трёх дней — отказ; с трёх дней текст пишет агент, а хранит приложение', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await mark(user.id, '2026-10-19')
    await mark(user.id, '2026-10-20')
    const request = () => diaryProcess.execute(new CreateWeekSummaryOperation({ userId: user.id, weekStart: '2026-10-19', now: NOW }))
    expect(await request()).toEqual({ success: false, error: DiaryOperationErrorCode.NOT_ENOUGH_DAYS })

    await mark(user.id, '2026-10-21', 1, 'work')
    const made = await request()
    expect(made).toMatchObject({ success: true, summary: { kind: 'week', periodStart: '2026-10-19' } })
    // The agent got the marks and the period, nothing about the person.
    const sent = JSON.parse(calls[0]!.body as string)
    expect(sent).toMatchObject({ kind: 'week', periodStart: '2026-10-19' })
    expect(sent.marks).toHaveLength(3)
    expect(JSON.stringify(sent)).not.toContain(user.email)

    const rows = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stats).toMatchObject({ markedDays: 3, final: false })
  })

  it('не чаще раза в сутки; через сутки новая версия заменяет прежнюю', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    const make = (now: Date) => diaryProcess.execute(new CreateWeekSummaryOperation({ userId: user.id, weekStart: '2026-10-19', now }))
    expect((await make(NOW)).success).toBe(true)
    expect(await make(new Date(NOW.getTime() + 60 * 60_000))).toEqual({ success: false, error: DiaryOperationErrorCode.TOO_SOON })
    expect((await make(new Date(NOW.getTime() + 25 * 60 * 60_000))).success).toBe(true)
    expect(await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))).toHaveLength(1)
  })

  it('агент недоступен: ничего не сохранено, лимит «раз в сутки» не потрачен', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    const make = () => diaryProcess.execute(new CreateWeekSummaryOperation({ userId: user.id, weekStart: '2026-10-19', now: NOW }))
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ error: { code: 'DIGEST_UNAVAILABLE' } }, 502) })
    expect(await make()).toEqual({ success: false, error: DiaryOperationErrorCode.SUMMARY_UNAVAILABLE })
    expect(await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))).toHaveLength(0)

    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    expect((await make()).success).toBe(true)
  })

  it('только текущая неделя собирается по кнопке', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    expect(
      await diaryProcess.execute(new CreateWeekSummaryOperation({ userId: user.id, weekStart: '2026-10-12', now: NOW })),
    ).toEqual({ success: false, error: DiaryOperationErrorCode.DATE_OUT_OF_RANGE })
  })
})

describe('итоги недели в понедельник и история года', () => {
  async function weekOfMarks(userId: string, monday: string) {
    for (let i = 0; i < 3; i += 1) {
      const date = new Date(`${monday}T00:00:00Z`)
      date.setUTCDate(date.getUTCDate() + i)
      await mark(userId, date.toISOString().slice(0, 10), 3)
    }
  }
  const MONDAY_0630 = new Date('2026-10-26T03:30:00Z') // 06:30 in Moscow, Monday 26 Oct
  const MONDAY_0530 = new Date('2026-10-26T02:30:00Z')

  it('до 06:00 по местному времени ничего не считается, после — окончательный итог прошедшей недели', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await weekOfMarks(user.id, '2026-10-19')
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0530 }))).toMatchObject({ weekly: 0 })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 1 })
    // A second pass (another replica, the next tick) makes nothing new.
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 0 })
    const [row] = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    expect(row).toMatchObject({ kind: 'week', periodStart: '2026-10-19' })
    expect(row?.stats).toMatchObject({ final: true })
  })

  it('неделя с меньше чем тремя днями итога не получает', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await mark(user.id, '2026-10-19')
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 0 })
  })

  it('шестой окончательный итог недели приносит историю года; «Дописать» — после ещё четырёх', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    const seed = async (monday: string) => {
      await getDb().insert(diarySummaries).values({
        userId: user.id, kind: 'week', periodStart: monday, text: `итог ${monday}`, stats: { final: true }, generatedAt: new Date('2026-09-01T00:00:00Z'),
      })
    }
    const mondays = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']
    for (const monday of mondays) await seed(monday)
    expect(
      await diaryProcess.execute(new CreateYearStoryOperation({ userId: user.id, year: 2026, now: NOW })),
    ).toEqual({ success: false, error: DiaryOperationErrorCode.NOT_ENOUGH_WEEKS })

    await weekOfMarks(user.id, '2026-10-19')
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 1, yearly: 1 })
    const yearCall = calls.find((c) => JSON.parse(c.body as string).kind === 'year')
    expect(JSON.parse(yearCall!.body as string).weekly).toHaveLength(6)

    const year = await diaryProcess.execute(new GetYearOperation({ userId: user.id, year: 2026, now: NOW }))
    if (!year.success) throw new Error('refused')
    expect(year.year).toMatchObject({ weeklyCount: 6, story: { weeklyCount: 6 } })

    // Not enough new weeks for «Дописать» yet.
    expect(
      await diaryProcess.execute(new CreateYearStoryOperation({ userId: user.id, year: 2026, now: NOW })),
    ).toEqual({ success: false, error: DiaryOperationErrorCode.NOT_ENOUGH_WEEKS })
    for (const monday of ['2026-10-05', '2026-10-12', '2026-10-26', '2026-11-02']) await seed(monday)
    expect(
      (await diaryProcess.execute(new CreateYearStoryOperation({ userId: user.id, year: 2026, now: NOW }))).success,
    ).toBe(true)
  })
})

describe('год в пикселях', () => {
  it('отдаёт отмеченные дни, их число и самый частый уровень (при равенстве — выше)', async () => {
    const user = await registerConfirmedUser()
    await mark(user.id, '2026-01-10', 2)
    await mark(user.id, '2026-02-10', 4)
    await mark(user.id, '2026-10-19', 3, 'work')
    const result = await diaryProcess.execute(new GetYearOperation({ userId: user.id, year: 2026, now: NOW }))
    if (!result.success) throw new Error('refused')
    expect(result.year).toMatchObject({ markedDays: 3, mostFrequent: 4, weeklyCount: 0, story: null })
    expect(result.year.days.find((d) => d.date === '2026-10-19')).toMatchObject({ mood: 3, factor: 'work' })
  })
})

describe('удаление аккаунта', () => {
  it('стирает отметки, итоги, настройки, подписки, доставки и токены виджета до анонимизации', async () => {
    const { accountDeletionProcess, DeleteAccountOperation } = await import('../src/processes/account-deletion')
    const { CreateWidgetTokenOperation, notificationsProcess, UpdateNotificationSettingsOperation, CreateSubscriptionOperation } =
      await import('../src/processes/notifications')
    const { mockAgent } = await import('./helpers')
    const { moodCheckins: marks, diarySummaries: summaries, notificationSettings: settings, pushSubscriptions: subs, widgetTokens } =
      await import('@ryadom/db/schema')
    const user = await registerConfirmedUser()
    mockAgent()
    await mark(user.id, '2026-10-19')
    await getDb().insert(summaries).values({ userId: user.id, kind: 'week', periodStart: '2026-10-19', text: 'итог', stats: null })
    await notificationsProcess.execute(new UpdateNotificationSettingsOperation({ userId: user.id, time: '21:00' }))
    await notificationsProcess.execute(
      new CreateSubscriptionOperation({ userId: user.id, channel: 'web_push', endpoint: 'https://push.example/x', p256dh: 'p', auth: 'a' }),
    )
    await notificationsProcess.execute(new CreateWidgetTokenOperation({ userId: user.id }))

    expect(await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))).toEqual({ success: true })

    for (const table of [marks, summaries, settings, subs, widgetTokens]) {
      expect(await getDb().select().from(table).where(eq(table.userId, user.id))).toEqual([])
    }
  })
})
