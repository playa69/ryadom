/**
 * The mood diary on the real core and database (`REQ-WELL-01`, `openspec/changes/add-mood-diary`):
 * the local day, one note a day, the week summaries the agent writes and the app keeps.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { diarySummaries, moodCheckins, users } from '@ryadom/db/schema'
import {
  CreateWidgetTokenOperation,
  PutMoodCheckinOperationErrorCode,
  diaryProcess,
  GetDiaryOperation,
  ListWeekSummariesOperation,
  PutMoodCheckinOperation,
  RunWeeklyDigestsOperation,
  recomputeSummariesAfterDialogDeleted,
} from '../src/processes/diary'
import { getDb } from '../src/shared'
import { json, mockFetch, registerConfirmedUser } from './helpers'

/** Saturday 24 Oct 2026, 12:00 in Moscow; the week starts on Monday the 19th. */
const NOW = new Date('2026-10-24T09:00:00Z')

const digestRoute = () =>
  json({ text: 'Спасибо, что ты рядом с собой на этой неделе.', stats: { markedDays: 3 } })

/** A mark written long ago: the quiet minute after the last tap is over, so the background pass may use it. */
const LONG_AGO = new Date('2026-01-01T00:00:00Z')

async function mark(userId: string, localDate: string, mood = 3, factor: 'work' | null = null, updatedAt = LONG_AGO) {
  await getDb().insert(moodCheckins).values({ userId, localDate, mood, factor, source: 'app', updatedAt })
}

/** Changes a mark the way a tap does, at `at`. */
async function remark(userId: string, localDate: string, mood: number, at: Date) {
  await getDb().update(moodCheckins).set({ mood, updatedAt: at }).where(and(eq(moodCheckins.userId, userId), eq(moodCheckins.localDate, localDate)))
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
      expect(await put(user.id, { date })).toEqual({ success: false, error: PutMoodCheckinOperationErrorCode.DATE_OUT_OF_RANGE })
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
  it('отдаёт сегодняшнюю отметку, месяц и неделю', async () => {
    const user = await registerConfirmedUser()
    await mark(user.id, '2026-10-19', 2)
    await put(user.id, { mood: 4, factor: 'sleep' })
    const view = await diaryProcess.execute(new GetDiaryOperation({ userId: user.id, now: NOW }))
    if (!view.success) throw new Error('refused')
    expect(view.diary.today).toMatchObject({ date: '2026-10-24', mood: 4, factor: 'sleep' })
    expect(view.diary.recent.map((d) => d.date)).toEqual(['2026-10-19', '2026-10-24'])
    expect(view.diary.week).toMatchObject({ start: '2026-10-19', markedDays: 2, summary: null })
    expect(view.diary).not.toHaveProperty('reminder')
  })

  const view = async (userId: string, now = NOW) => {
    const result = await diaryProcess.execute(new GetDiaryOperation({ userId, now }))
    if (!result.success) throw new Error('refused')
    return result.diary
  }

  it('серия: дни подряд до сегодня; пока сегодня не отмечено, считается по вчера; пропуск обрывает; без отметок 0', async () => {
    const user = await registerConfirmedUser()
    expect((await view(user.id)).streak).toBe(0)

    for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) await mark(user.id, d)
    // Today (24th) is not marked yet: the run ending yesterday still counts, nothing is lost before the day is over.
    expect((await view(user.id)).streak).toBe(4)

    await mark(user.id, '2026-10-24')
    expect((await view(user.id)).streak).toBe(5)

    // A missing day cuts the run: 19th is absent, 18th and earlier do not count.
    await mark(user.id, '2026-10-17')
    await mark(user.id, '2026-10-18')
    expect((await view(user.id)).streak).toBe(5)

    // The next local day nobody has marked and yesterday is the 24th: still 5 until that day ends...
    expect((await view(user.id, new Date('2026-10-25T09:00:00Z'))).streak).toBe(5)
    // ...and gone when two days passed without a note.
    expect((await view(user.id, new Date('2026-10-26T09:00:00Z'))).streak).toBe(0)
  })

  it('серия длиннее одного чтения (400 дней) считается целиком', async () => {
    const user = await registerConfirmedUser()
    const days: { userId: string; localDate: string; mood: number; source: 'app' }[] = []
    for (let i = 0; i < 450; i += 1) {
      const date = new Date(Date.UTC(2026, 9, 24 - i)).toISOString().slice(0, 10)
      days.push({ userId: user.id, localDate: date, mood: 3, source: 'app' })
    }
    await getDb().insert(moodCheckins).values(days)
    expect((await view(user.id)).streak).toBe(450)
  })

  it('окно графика: 28 дней до сегодня включительно, через границу месяца; старше и будущее не попадают', async () => {
    const user = await registerConfirmedUser()
    // 24 Oct is today: the window is 27 Sep … 24 Oct.
    for (const d of ['2026-09-26', '2026-09-27', '2026-10-01', '2026-10-24', '2026-10-25']) await mark(user.id, d)
    const diary = await view(user.id)
    expect(diary.recent.map((d) => d.date)).toEqual(['2026-09-27', '2026-10-01', '2026-10-24'])
  })
})

describe('итоги текущей недели: пишутся в фоне', () => {
  const tick = (now: Date) => diaryProcess.execute(new RunWeeklyDigestsOperation({ now }))
  const weekRows = (userId: string) => getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, userId))
  const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)
  const view = async (userId: string) => {
    const result = await diaryProcess.execute(new GetDiaryOperation({ userId, now: NOW }))
    if (!result.success) throw new Error('no diary')
    return result.diary
  }

  it('меньше трёх дней текста нет; с третьего дня тик пишет его сам, а хранит приложение', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await mark(user.id, '2026-10-19')
    await mark(user.id, '2026-10-20')
    expect(await tick(NOW)).toMatchObject({ weekly: 0 })
    expect(calls).toHaveLength(0)

    await mark(user.id, '2026-10-21', 1, 'work')
    expect(await tick(NOW)).toMatchObject({ weekly: 1, weeklyUserIds: [user.id] })
    // The agent got the marks and the period, nothing about the person.
    const sent = JSON.parse(calls[0]!.body as string)
    expect(sent).toMatchObject({ kind: 'week', periodStart: '2026-10-19' })
    expect(sent.marks).toHaveLength(3)
    expect(JSON.stringify(sent)).not.toContain(user.email)

    const rows = await weekRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stats).toMatchObject({ markedDays: 3, hardDays: 1, final: false })
    // Nothing changed since: the next ticks write nothing and ask nobody.
    expect(await tick(minutes(1))).toMatchObject({ weekly: 0 })
    expect(calls).toHaveLength(1)
    expect((await view(user.id)).week.summary?.text).toContain('Спасибо')
  })

  it('отметки, которым нет минуты, ждут: несколько касаний подряд — один текст', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await mark(user.id, '2026-10-19')
    await mark(user.id, '2026-10-20')
    await mark(user.id, '2026-10-21', 3, null, new Date(NOW.getTime() - 20_000))
    expect(await tick(NOW)).toMatchObject({ weekly: 0 })
    expect(calls).toHaveLength(0)
    expect(await tick(minutes(1))).toMatchObject({ weekly: 1 })
    expect(calls).toHaveLength(1)
  })

  it('настроение изменили после текста — тик пишет новый; прежний виден, пока пишется', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Первый текст.', stats: {} }) })
    await tick(NOW)
    expect((await view(user.id)).week.summary?.text).toBe('Первый текст.')

    await remark(user.id, '2026-10-21', 1, minutes(5))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { calls } = mockFetch({
      'POST http://agent.test/v1/users/*/digests': async () => {
        await gate
        return json({ text: 'Второй текст.', stats: {} })
      },
    })
    // Less than a minute after the tap: nothing yet.
    expect(await tick(minutes(5.5))).toMatchObject({ weekly: 0 })
    const running = tick(minutes(7))
    await new Promise((r) => setTimeout(r, 300))
    expect(await weekRows(user.id)).toMatchObject([{ status: 'pending', text: 'Первый текст.' }])
    expect((await view(user.id)).week.summary?.text).toBe('Первый текст.')
    release()
    expect(await running).toMatchObject({ weekly: 1 })
    expect((await view(user.id)).week.summary?.text).toBe('Второй текст.')
    expect((await weekRows(user.id))[0]?.stats).toMatchObject({ hardDays: 1, final: false })
    expect(calls).toHaveLength(1)
    expect(await tick(minutes(8))).toMatchObject({ weekly: 0 })
  })

  it('агент недоступен: прежний текст остаётся, следующий тик пробует снова', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ error: { code: 'DIGEST_UNAVAILABLE' } }, 502) })
    expect(await tick(NOW)).toMatchObject({ weekly: 0 })
    expect(await weekRows(user.id)).toEqual([])

    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Первый текст.', stats: {} }) })
    expect(await tick(minutes(1))).toMatchObject({ weekly: 1 })
    await remark(user.id, '2026-10-20', 5, minutes(2))
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({}, 502) })
    expect(await tick(minutes(4))).toMatchObject({ weekly: 0 })
    expect(await weekRows(user.id)).toMatchObject([{ status: 'ready', text: 'Первый текст.' }])

    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Новый текст.', stats: {} }) })
    expect(await tick(minutes(5))).toMatchObject({ weekly: 1 })
    expect((await view(user.id)).week.summary?.text).toBe('Новый текст.')
  })

  it('текст недели без отметок-источников удалён вместе с разговором: следующий тик пишет его заново сам', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await tick(NOW)
    await recomputeSummariesAfterDialogDeleted({ userId: user.id, dialogAt: new Date('2026-10-21T08:00:00Z'), now: minutes(1) })
    expect((await view(user.id)).week.summary).toBeNull()
    expect(await tick(minutes(2))).toMatchObject({ weekly: 1 })
    expect((await view(user.id)).week.summary).not.toBeNull()
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
})

describe('удаление аккаунта', () => {
  it('стирает отметки, итоги и токены виджета до анонимизации', async () => {
    const { accountDeletionProcess, DeleteAccountOperation } = await import('../src/processes/account-deletion')
    const { mockAgent } = await import('./helpers')
    const { moodCheckins: marks, diarySummaries: summaries, widgetTokens } = await import('@ryadom/db/schema')
    const user = await registerConfirmedUser()
    mockAgent()
    await mark(user.id, '2026-10-19')
    await getDb().insert(summaries).values({ userId: user.id, kind: 'week', periodStart: '2026-10-19', text: 'итог', stats: null })
    const widget = await diaryProcess.execute(new CreateWidgetTokenOperation({ userId: user.id }))
    expect(widget.success).toBe(true)

    expect(await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))).toEqual({ success: true })

    for (const table of [marks, summaries, widgetTokens]) {
      expect(await getDb().select().from(table).where(eq(table.userId, user.id))).toEqual([])
    }
  })
})

describe('тик итогов недели: период занимает одна реплика', () => {
  const MONDAY_0630 = new Date('2026-10-26T03:30:00Z')

  it('две реплики одновременно — агент вызван один раз, итог один; пока считается — его нет в списках', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { calls } = mockFetch({
      'POST http://agent.test/v1/users/*/digests': async () => {
        await gate
        return digestRoute()
      },
    })
    const first = diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))
    const second = diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))
    // While the agent writes, the period is a `pending` row and the person has no summary yet.
    await new Promise((r) => setTimeout(r, 300))
    const pending = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    expect(pending).toMatchObject([{ status: 'pending', text: '' }])
    const listed = await diaryProcess.execute(new ListWeekSummariesOperation({ userId: user.id }))
    expect(listed).toMatchObject({ success: true, summaries: [] })
    release()
    const results = await Promise.all([first, second])
    expect(results.map((r) => (r.success ? r.weekly : 0)).sort()).toEqual([0, 1])
    expect(calls.filter((c) => c.url.pathname.endsWith('/digests'))).toHaveLength(1)
    const rows = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    expect(rows).toMatchObject([{ status: 'ready', stats: { final: true } }])
  })

  it('агент не ответил — занятость снимается, следующий тик пробует снова', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({}, 502) })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 0 })
    expect(await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))).toEqual([])
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 1 })
  })

  it('занятость, которую не завершила реплика, через 15 минут считается брошенной', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    await getDb().insert(diarySummaries).values({
      userId: user.id, kind: 'week', periodStart: '2026-10-19', text: '', status: 'pending', generatedAt: new Date(MONDAY_0630.getTime() - 5 * 60_000),
    })
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 0 })
    const later = new Date(MONDAY_0630.getTime() + 11 * 60_000)
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: later }))).toMatchObject({ weekly: 1 })
  })

  it('окончательный итог уже есть, а отметку недели изменили позже (вчера из очереди) — он пишется заново, тоже окончательным', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Закрыто.', stats: {} }) })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 1 })
    await getDb().update(moodCheckins).set({ mood: 1, updatedAt: new Date(MONDAY_0630.getTime() + 60_000) }).where(eq(moodCheckins.userId, user.id))
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Закрыто заново.', stats: {} }) })
    const later = new Date(MONDAY_0630.getTime() + 5 * 60_000)
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: later }))).toMatchObject({ weekly: 1 })
    const [row] = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    expect(row).toMatchObject({ status: 'ready', text: 'Закрыто заново.', stats: { final: true, hardDays: 3 } })
  })

  it('итог, написанный в фоне на неделе, закрывается окончательным в понедельник', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['19', '20', '21']) await mark(user.id, `2026-10-${day}`)
    await getDb().insert(diarySummaries).values({
      userId: user.id, kind: 'week', periodStart: '2026-10-19', text: 'черновик', stats: { final: false }, generatedAt: new Date('2026-10-21T10:00:00Z'),
    })
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: MONDAY_0630 }))).toMatchObject({ weekly: 1 })
    const [row] = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    expect(row).toMatchObject({ status: 'ready', stats: { final: true } })
    expect(row?.text).not.toBe('черновик')
  })
})

describe('удаление разговора: итоги недели пересобираются', () => {
  const dialogAt = new Date('2026-10-07T10:00:00Z') // Wednesday of the week of 5 Oct, a finished week
  const digestCalls = (calls: { url: URL; body: string }[]) => calls.filter((c) => c.url.pathname.endsWith('/digests'))

  async function finalWeek(userId: string, monday: string) {
    await getDb().insert(diarySummaries).values({
      userId, kind: 'week', periodStart: monday, text: `итог ${monday}`, stats: { final: true, markedDays: 3 }, generatedAt: new Date('2026-09-01T00:00:00Z'),
    })
  }
  const recompute = (userId: string, at = dialogAt) => recomputeSummariesAfterDialogDeleted({ userId, dialogAt: at, now: NOW })
  const rowsOf = (userId: string) => getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, userId))

  it('текст недели пропадает сразу; тик пишет неделю заново один раз (две реплики)', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['05', '06', '07']) await mark(user.id, `2026-10-${day}`)
    for (const monday of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']) await finalWeek(user.id, monday)

    expect(await recompute(user.id)).toEqual({ success: true, weekDeleted: true, scheduled: true })

    // At once: the retelling is gone from every place that shows it.
    const listed = await diaryProcess.execute(new ListWeekSummariesOperation({ userId: user.id }))
    if (!listed.success) throw new Error('refused')
    expect(listed.summaries.map((x) => x.periodStart)).not.toContain('2026-10-05')
    expect(listed.summaries).toHaveLength(5)

    // The scheduler writes it again; two replicas at once ask the agent once for the week.
    const { calls } = mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await Promise.all([
      diaryProcess.execute(new RunWeeklyDigestsOperation({ now: NOW })),
      diaryProcess.execute(new RunWeeklyDigestsOperation({ now: NOW })),
    ])
    const sent = digestCalls(calls).map((c) => JSON.parse(c.body).kind)
    expect(sent).toEqual(['week'])
    const rows = await rowsOf(user.id)
    expect(rows.filter((r) => r.status === 'pending')).toEqual([])
    expect(rows.find((r) => r.kind === 'week' && r.periodStart === '2026-10-05')).toMatchObject({ status: 'ready', stats: { final: true } })
    // Other weeks were not touched.
    expect(rows.find((r) => r.periodStart === '2026-09-14')?.text).toBe('итог 2026-09-14')
    // And a later pass has nothing left to do.
    await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: NOW }))
    expect(digestCalls(calls)).toHaveLength(1)
  })

  it('у недели осталось меньше трёх отмеченных дней: текст убран и заново не пишется, маркера не остаётся', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['05', '06']) await mark(user.id, `2026-10-${day}`)
    await finalWeek(user.id, '2026-10-05')
    expect(await recompute(user.id)).toMatchObject({ success: true, weekDeleted: true, scheduled: true })
    const { calls } = mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: NOW }))
    expect(digestCalls(calls)).toHaveLength(0)
    expect(await rowsOf(user.id)).toEqual([])
  })

  it('агент не ответил: маркер остаётся, следующий тик пробует снова', async () => {
    const user = await registerConfirmedUser()
    for (const day of ['05', '06', '07']) await mark(user.id, `2026-10-${day}`)
    await finalWeek(user.id, '2026-10-05')
    await recompute(user.id)
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({}, 502) })
    await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: NOW }))
    expect(await rowsOf(user.id)).toMatchObject([{ status: 'pending', text: '', stats: { recompute: true } }])
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': digestRoute })
    expect(await diaryProcess.execute(new RunWeeklyDigestsOperation({ now: NOW }))).toMatchObject({ weekly: 1 })
    expect(await rowsOf(user.id)).toMatchObject([{ status: 'ready', stats: { final: true } }])
  })

  it('неделя вне окна и текущая неделя: текст убран, пересборки по маркеру нет', async () => {
    const user = await registerConfirmedUser()
    await finalWeek(user.id, '2026-08-03')
    // Current week: no marker; the background pass writes the text again by itself.
    await getDb().insert(diarySummaries).values({
      userId: user.id, kind: 'week', periodStart: '2026-10-19', text: 'черновик', stats: { final: false }, generatedAt: NOW,
    })
    expect(await recompute(user.id, new Date('2026-08-05T10:00:00Z'))).toMatchObject({ weekDeleted: true, scheduled: false })
    expect(await recompute(user.id, new Date('2026-10-22T10:00:00Z'))).toMatchObject({ weekDeleted: true, scheduled: false })
    expect(await rowsOf(user.id)).toEqual([])
  })

  it('нет итога у недели: ничего не удаляется, для законченной недели ставится маркер; неизвестный человек — отказ', async () => {
    const user = await registerConfirmedUser()
    expect(await recompute(user.id)).toEqual({ success: true, weekDeleted: false, scheduled: true })
    expect(await recompute('00000000-0000-4000-8000-000000000000')).toMatchObject({ success: false })
  })

  it('строки «считается» и маркеры не видны ни в экране дневника, ни в списках', async () => {
    const user = await registerConfirmedUser()
    await getDb().insert(diarySummaries).values([
      { userId: user.id, kind: 'week', periodStart: '2026-10-19', text: '', status: 'pending', generatedAt: NOW },
      { userId: user.id, kind: 'week', periodStart: '2026-10-05', text: '', status: 'pending', stats: { recompute: true }, generatedAt: new Date(0) },
    ])
    const diary = await diaryProcess.execute(new GetDiaryOperation({ userId: user.id, now: NOW }))
    if (!diary.success) throw new Error('refused')
    expect(diary.diary.week.summary).toBeNull()
    expect(await diaryProcess.execute(new ListWeekSummariesOperation({ userId: user.id }))).toMatchObject({ summaries: [] })
  })
})

describe('итог прошлой недели на экране', () => {
  it('previousWeek — окончательный итог прошлой недели; черновик и чужая неделя не подходят', async () => {
    const user = await registerConfirmedUser()
    const read = async () => {
      const diary = await diaryProcess.execute(new GetDiaryOperation({ userId: user.id, now: NOW }))
      if (!diary.success) throw new Error('refused')
      return diary.diary.previousWeek
    }
    expect(await read()).toBeNull()
    const row = { userId: user.id, kind: 'week' as const, generatedAt: NOW }
    // A draft of the previous week and a final one of the week before it do not count.
    await getDb().insert(diarySummaries).values([
      { ...row, periodStart: '2026-10-12', text: 'черновик', stats: { final: false } },
      { ...row, periodStart: '2026-10-05', text: 'давняя', stats: { final: true } },
    ])
    expect(await read()).toBeNull()
    await getDb().update(diarySummaries).set({ stats: { final: true }, text: 'прошлая' }).where(eq(diarySummaries.periodStart, '2026-10-12'))
    expect(await read()).toMatchObject({ periodStart: '2026-10-12', text: 'прошлая' })
  })
})
