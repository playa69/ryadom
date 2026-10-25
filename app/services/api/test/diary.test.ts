/**
 * The mood diary over HTTP (`REQ-WELL-01`…`03`): flag off, two taps, summaries, the
 * widget token. The core is real, the agent is a stub.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { moodCheckins, users } from '@ryadom/db/schema'
import { getDb } from '@ryadom/core/shared'
import {
  DiaryApiErrorCode,
  type DiaryApiResponse,
  type DiaryYearApiResponse,
  type PutMoodCheckinApiResponse,
  type WidgetTokenApiResponse,
} from '@ryadom/contracts/api/diary'
import { call, json, makeApp, mockFetch, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

async function signedIn() {
  resetLimits()
  const login = await signUpAndIn(app)
  return { token: login.tokens.accessToken, userId: login.user.id }
}

/** Monday of the current week in Moscow, plus `n` days. */
function dayOfThisWeek(n: number): string {
  const now = new Date(Date.now() + 3 * 3600_000)
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7) + n))
  return monday.toISOString().slice(0, 10)
}

describe('отметка в два касания', () => {
  it('без сессии — 401', async () => {
    expect((await call(app, 'GET', '/api/diary')).status).toBe(401)
    expect((await call(app, 'PUT', '/api/diary/checkins/today', { mood: 3 })).status).toBe(401)
  })

  it('уровень, затем фактор; «передумал» заменяет уровень; экран и год это видят', async () => {
    const { token } = await signedIn()
    const first = ok<PutMoodCheckinApiResponse>(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 3 }, token))
    expect(first).toMatchObject({ changed: false, hardStreak: 0, checkin: { mood: 3, factor: null } })
    ok(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 3, factor: 'work' }, token))
    const changed = ok<PutMoodCheckinApiResponse>(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 4 }, token))
    expect(changed).toMatchObject({ changed: true, checkin: { mood: 4, factor: 'work' } })

    const diary = ok<DiaryApiResponse>(await call(app, 'GET', '/api/diary', undefined, token))
    expect(diary.today).toEqual({ mood: 4, factor: 'work' })
    expect(diary.month).toHaveLength(1)
    expect(diary).not.toHaveProperty('reminder')

    const year = ok<DiaryYearApiResponse>(await call(app, 'GET', '/api/diary/year', undefined, token))
    expect(year).toMatchObject({ markedDays: 1, mostFrequent: 4, weeklyCount: 0, story: null })
  })

  it('уровень вне 1–5 и неизвестный фактор — 400; чужая дата — 422', async () => {
    const { token } = await signedIn()
    for (const bad of [{ mood: 0 }, { mood: 6 }, { mood: 3, factor: 'weather' }, {}]) {
      expect((await call(app, 'PUT', '/api/diary/checkins/today', bad, token)).status).toBe(400)
    }
    expect((await call(app, 'PUT', '/api/diary/checkins/today', { mood: 3, date: '2020-01-01' }, token)).status).toBe(422)
  })

  it('часовой пояс человека задаёт день отметки', async () => {
    const { token, userId } = await signedIn()
    ok(await call(app, 'PATCH', '/api/auth/me', { timezone: 'Pacific/Kiritimati' }, token))
    ok(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 5 }, token))
    const [row] = await getDb().select().from(moodCheckins).where(eq(moodCheckins.userId, userId))
    // UTC+14: the local date is one that Moscow has not reached for a few hours of the day, never earlier than UTC's.
    expect((row?.localDate ?? '') >= new Date().toISOString().slice(0, 10)).toBe(true)
  })

  it('чужой аккаунт не видит чужих отметок', async () => {
    const mine = await signedIn()
    ok(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 1 }, mine.token))
    const other = await signedIn()
    const diary = ok<DiaryApiResponse>(await call(app, 'GET', '/api/diary', undefined, other.token))
    expect(diary.today).toBeNull()
    expect(diary.month).toEqual([])
  })
})

describe('итоги недели', () => {
  it('с двух дней — отказ с кодом; с трёх — текст агента, повтор в тот же день — отказ', async () => {
    const { token, userId } = await signedIn()
    const agent = mockFetch({
      'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Спасибо, что ты рядом с собой.', stats: {} }),
    })
    for (const n of [0, 1]) {
      await getDb().insert(moodCheckins).values({ userId, localDate: dayOfThisWeek(n), mood: 3, source: 'app' })
    }
    const body = { weekStart: dayOfThisWeek(0) }
    refusedWith(await call(app, 'POST', '/api/diary/summaries/week', body, token), DiaryApiErrorCode.NOT_ENOUGH_DAYS)
    await getDb().insert(moodCheckins).values({ userId, localDate: dayOfThisWeek(2), mood: 1, source: 'app' })
    const made = ok<{ text: string; kind: string }>(await call(app, 'POST', '/api/diary/summaries/week', body, token))
    expect(made).toMatchObject({ kind: 'week', text: 'Спасибо, что ты рядом с собой.' })
    refusedWith(await call(app, 'POST', '/api/diary/summaries/week', body, token), DiaryApiErrorCode.TOO_SOON)
    expect(agent.calls).toHaveLength(1)

    const diary = ok<DiaryApiResponse>(await call(app, 'GET', '/api/diary', undefined, token))
    expect(diary.week.summary?.text).toBe('Спасибо, что ты рядом с собой.')
  })

  it('агент не ответил — код SUMMARY_UNAVAILABLE, повторить можно сразу', async () => {
    const { token, userId } = await signedIn()
    for (const n of [0, 1, 2]) {
      await getDb().insert(moodCheckins).values({ userId, localDate: dayOfThisWeek(n), mood: 3, source: 'app' })
    }
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({}, 502) })
    refusedWith(
      await call(app, 'POST', '/api/diary/summaries/week', { weekStart: dayOfThisWeek(0) }, token),
      DiaryApiErrorCode.SUMMARY_UNAVAILABLE,
    )
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Готово.', stats: {} }) })
    ok(await call(app, 'POST', '/api/diary/summaries/week', { weekStart: dayOfThisWeek(0) }, token))
  })

  it('история года: меньше шести итогов — NOT_ENOUGH_WEEKS', async () => {
    const { token } = await signedIn()
    refusedWith(await call(app, 'POST', '/api/diary/summaries/year', { year: 2026 }, token), DiaryApiErrorCode.NOT_ENOUGH_WEEKS)
  })

  it('события недели: пустой список и признак «память включена»', async () => {
    const { token } = await signedIn()
    mockFetch({
      'GET http://agent.test/v1/users/*/memory': () =>
        json({ available: true, mode: 'on', enabled: true, consentVersion: 'v', consentAt: null, rulesVersion: '1', limits: { maxFacts: 50 }, facts: [] }),
    })
    expect(ok(await call(app, 'GET', '/api/diary/events', undefined, token))).toEqual({ memoryEnabled: true, items: [] })
  })
})

describe('виджет Android', () => {
  async function widgetCall(method: string, path: string, token: string | null, body?: unknown) {
    const response = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Widget ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json().catch(() => null)) as { status?: boolean; result?: any } | null }
  }

  it('токен только читает сегодняшнюю отметку и ставит её; сессионный токен для виджета не годится', async () => {
    const { token } = await signedIn()
    const { token: widget } = ok<WidgetTokenApiResponse>(await call(app, 'POST', '/api/diary/widget-token', undefined, token))
    expect(widget).toMatch(/^wdg_/)

    expect((await widgetCall('GET', '/api/diary/widget/today', widget)).body?.result).toEqual({ today: null })
    const put = await widgetCall('PUT', '/api/diary/widget/checkin', widget, { mood: 2, factor: 'sleep' })
    expect(put.body?.result).toMatchObject({ checkin: { mood: 2, factor: 'sleep' } })
    expect((await widgetCall('GET', '/api/diary/widget/today', widget)).body?.result).toEqual({ today: { mood: 2, factor: 'sleep' } })
    // The note is visible in the app, marked as coming from the widget.
    expect(ok<DiaryApiResponse>(await call(app, 'GET', '/api/diary', undefined, token)).today).toEqual({ mood: 2, factor: 'sleep' })

    // The widget token opens nothing else.
    const asBearer = await app.request('/api/diary', { headers: { Authorization: `Bearer ${widget}` } })
    expect(asBearer.status).toBe(401)
    // And the session token is not a widget token.
    expect((await widgetCall('GET', '/api/diary/widget/today', token)).status).toBe(401)
    expect((await widgetCall('GET', '/api/diary/widget/today', null)).status).toBe(401)
  })

  it('отзыв и новый токен: прежний перестаёт работать; удаление аккаунта тоже отзывает', async () => {
    const { token, userId } = await signedIn()
    const first = ok<WidgetTokenApiResponse>(await call(app, 'POST', '/api/diary/widget-token', undefined, token)).token
    const second = ok<WidgetTokenApiResponse>(await call(app, 'POST', '/api/diary/widget-token', undefined, token)).token
    expect((await widgetCall('GET', '/api/diary/widget/today', first)).status).toBe(401)
    expect((await widgetCall('GET', '/api/diary/widget/today', second)).status).toBe(200)
    ok(await call(app, 'DELETE', '/api/diary/widget-token', undefined, token))
    expect((await widgetCall('GET', '/api/diary/widget/today', second)).status).toBe(401)

    const third = ok<WidgetTokenApiResponse>(await call(app, 'POST', '/api/diary/widget-token', undefined, token)).token
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, userId))
    expect((await widgetCall('GET', '/api/diary/widget/today', third)).status).toBe(401)
  })
})
