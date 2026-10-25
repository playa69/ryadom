/**
 * What the mood diary reports to product analytics (design D12): that an action happened, with a fixed
 * word or a flag, and never a mood, a factor, a date, a count of days or a text.
 */
import { describe, expect, it } from 'vitest'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { moodCheckins, diarySummaries } from '@ryadom/db/schema'
import { getDb } from '@ryadom/core/shared'
import { runDiaryPass } from '../src/lib/diary-scheduler'
import { call, json, makeApp, mockFetch, ok, recordingAnalytics, signUpAndIn } from './helpers'

const analytics = recordingAnalytics()
const { app, resetLimits } = makeApp({ analytics })

async function signedIn() {
  resetLimits()
  analytics.events.length = 0
  const login = await signUpAndIn(app)
  return { token: login.tokens.accessToken, userId: login.user.id }
}

/** Monday of the current week in Moscow, plus `n` days. */
function dayOfThisWeek(n: number): string {
  const now = new Date(Date.now() + 3 * 3600_000)
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7) + n))
  return monday.toISOString().slice(0, 10)
}

const DIARY_EVENTS: string[] = [
  AnalyticsEvent.MoodCheckedIn,
  AnalyticsEvent.WeekSummaryGenerated,
  AnalyticsEvent.DiarySummaryRefused,
]
const diaryEvents = () => analytics.events.filter((e) => DIARY_EVENTS.includes(e.event))

/** The only properties a diary event may have: fixed words and flags. */
const ALLOWED_KEYS = ['source', 'with_factor', 'changed', 'trigger', 'kind', 'reason']

/** Whatever the diary reports, nothing in it may carry the person's data. */
function expectNoPersonalData() {
  for (const { properties } of diaryEvents()) {
    for (const key of Object.keys(properties)) expect(ALLOWED_KEYS).toContain(key)
    for (const value of Object.values(properties)) {
      expect(['string', 'boolean']).toContain(typeof value)
      if (typeof value === 'string') expect(value).not.toMatch(/\d{4}-\d{2}|работа|сон|близкие|здоровье|деньги/i)
    }
  }
}

describe('аналитика дневника', () => {
  it('отметка: источник, есть ли фактор и заменена ли; значения настроения и фактора нет', async () => {
    const { token, userId } = await signedIn()
    ok(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 1, factor: 'health' }, token))
    ok(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 5 }, token))
    const events = diaryEvents().filter((e) => e.event === AnalyticsEvent.MoodCheckedIn)
    expect(events).toEqual([
      { userId, event: 'mood_checked_in', properties: { source: 'app', with_factor: true, changed: false } },
      { userId, event: 'mood_checked_in', properties: { source: 'app', with_factor: true, changed: true } },
    ])
    expectNoPersonalData()
  })

  it('отказ в итогах: вид и причина, без чисел и дат', async () => {
    const { token, userId } = await signedIn()
    await getDb().insert(moodCheckins).values({ userId, localDate: dayOfThisWeek(0), mood: 3, source: 'app' })
    ok(await call(app, 'PUT', '/api/diary/checkins/today', { mood: 3 }, token))
    const week = { weekStart: dayOfThisWeek(0) }
    await call(app, 'POST', '/api/diary/summaries/week', week, token)
    // Three marked days and a dead agent: the third kind of refusal.
    for (const n of [1, 2]) await getDb().insert(moodCheckins).values({ userId, localDate: dayOfThisWeek(n), mood: 2, source: 'app' }).onConflictDoNothing()
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({}, 502) })
    await call(app, 'POST', '/api/diary/summaries/week', week, token)
    expect(diaryEvents().filter((e) => e.event === AnalyticsEvent.DiarySummaryRefused).map((e) => e.properties)).toEqual([
      { kind: 'week', reason: 'not_enough' },
      { kind: 'week', reason: 'agent_unavailable' },
    ])
    expectNoPersonalData()
  })

  it('кнопка итогов: одно событие с триггером button', async () => {
    const { token, userId } = await signedIn()
    for (const n of [0, 1, 2]) await getDb().insert(moodCheckins).values({ userId, localDate: dayOfThisWeek(n), mood: 3, source: 'app' })
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Готово.', stats: {} }) })
    ok(await call(app, 'POST', '/api/diary/summaries/week', { weekStart: dayOfThisWeek(0) }, token))
    expect(diaryEvents()).toEqual([{ userId, event: 'week_summary_generated', properties: { trigger: 'button' } }])
  })

  it('понедельничный проход: событие auto для каждого, кому закрыли неделю', async () => {
    const { userId } = await signedIn()
    const lastMonday = new Date(Date.parse(`${dayOfThisWeek(0)}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)
    for (const n of [0, 1, 2]) {
      const day = new Date(Date.parse(`${lastMonday}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
      await getDb().insert(moodCheckins).values({ userId, localDate: day, mood: 3, source: 'app' })
    }
    mockFetch({ 'POST http://agent.test/v1/users/*/digests': () => json({ text: 'Итог.', stats: {} }) })
    // Wednesday noon in Moscow of the current week: past Monday 06:00, the week before is closed.
    const now = new Date(Date.parse(`${dayOfThisWeek(2)}T09:00:00Z`))
    expect(await runDiaryPass(analytics, now)).toMatchObject({ weekly: 1 })
    expect(diaryEvents()).toEqual([{ userId, event: 'week_summary_generated', properties: { trigger: 'auto' } }])
    // A second pass closes nothing and reports nothing.
    analytics.events.length = 0
    expect(await runDiaryPass(analytics, now)).toMatchObject({ weekly: 0 })
    expect(diaryEvents()).toEqual([])
    const rows = await getDb().select().from(diarySummaries)
    expect(rows).toHaveLength(1)
    expectNoPersonalData()
  })
})
