import type { APIRequestContext } from '@playwright/test'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { APP_URL } from '../playwright.config'
import { button, openApp, openTab, startAnonymously } from '../support/app'
import { expect, test } from '../support/fixtures'
import { trackSession } from '../support/session'
// Written by the server side of the change (a direct write to the table: the API takes only today and yesterday).
import { ageWeekSummary, seedMarks } from '../support/diary'

/**
 * The mood diary in the app (PWA), `REQ-WELL-01`…`03`: the card in two taps, a change of mind, the chart,
 * the bridge to a conversation, a note made without a network, the journal segment, and the week summary that the background pass writes after three marked days and rewrites when the mood changes (agent mock: a fixed text from the marks).
 */

/** The day in the browser's zone (the config sets Europe/Moscow), as the diary counts it. */
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })

async function serverDiary(request: APIRequestContext, accessToken: string) {
  const response = await request.get(`${APP_URL}/api/diary`, { headers: { Authorization: `Bearer ${accessToken}` } })
  expect(response.status(), 'дневник на сервере').toBe(200)
  const body = (await response.json()) as { status: boolean; result: DiaryApiResponse }
  return body.result
}

test('дневник: пустой → отметка в два касания → передумал → график → мост → без сети', async ({ page, request, shot }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')

  const diary = page.locator('.page-current[data-name="diary"]')
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Как ты сегодня?')
  await expect(diary.getByTestId('diary-chart-empty')).toContainText('здесь появится график')
  await expect(diary.getByTestId('diary-week-waiting')).toContainText('(сейчас: 0 из 3)')
  // The events of the week do not live on this page, and memory is not mentioned.
  await expect(diary.getByTestId('diary-events-card')).toHaveCount(0)
  await expect(diary).not.toContainText(/События|памят/i)
  await expect(diary.getByTestId('self-check-block')).toBeVisible()
  await expect(diary.getByTestId('diary-segment-tests')).toBeVisible()
  await expect(diary.getByTestId('diary-streak')).toHaveCount(0)
  await shot(page, 'diary-empty')

  // ── two taps ─────────────────────────────────────────────────────────────────────────────
  await diary.getByTestId('diary-mood-3').click()
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await expect(diary.getByTestId('diary-factors')).toContainText('Что повлияло больше всего?')
  await diary.getByTestId('diary-factor-work').click()
  // The strip folds into one line; the streak badge counts the first day.
  await expect(diary.getByTestId('diary-factor-line')).toHaveText('Повлияло: работа')
  await expect(diary.getByTestId('diary-factors')).toHaveCount(0)
  await expect(diary.getByTestId('diary-streak')).toContainText('1 дн.')
  await expect(diary.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(diary.getByTestId('diary-chart')).toHaveAttribute('aria-label', /отмечено 1 день, чаще всего — нормально/)
  await expect(diary.getByTestId('diary-week-waiting')).toContainText('(сейчас: 1 из 3)')
  await shot(page, 'diary-marked')

  // The server has it, so another device of the person sees it too.
  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).today)
    .toEqual({ mood: 3, factor: 'work' })

  // ── a change of mind: the day keeps one note and the factor ──────────────────────────────
  await diary.getByTestId('diary-mood-4').click()
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Сегодня: хорошо')
  await expect(diary.getByTestId('diary-factor-line')).toHaveText('Повлияло: работа')
  await expect(diary.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(diary.getByTestId('diary-chart-point')).toHaveAttribute('data-mood', '4')
  // A tap on the line opens the strip again; the same factor once more takes it off.
  await diary.getByTestId('diary-factor-line').click()
  await expect(diary.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await diary.getByTestId('diary-factor-work').click()
  await expect(diary.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'false')

  // ── the bridge after a heavy day, and none after a good one ──────────────────────────────
  await expect(diary.getByTestId('diary-bridge')).toHaveCount(0)
  await diary.getByTestId('diary-mood-1').click()
  await expect(diary.getByTestId('diary-bridge')).toContainText('Хочешь рассказать, что случилось?')
  await diary.getByTestId('diary-mood-5').click()
  await expect(diary.getByTestId('diary-bridge')).toHaveCount(0)
  await diary.getByTestId('diary-mood-2').click()
  await shot(page, 'diary-bridge')
  await diary.getByTestId('diary-bridge-talk').click()
  // «Поговорить» starts a conversation as the home button does: it opens on the voice screen.
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  // The arrow in the bar leaves the conversation (the tab bar is hidden while it is open).
  await page.locator('.page-current .navbar a.back').first().click()
  await expect(page.locator('#rd-tabbar')).toBeVisible()

  // ── without a network: the choice shows at once and goes up when the connection is back ──
  await openTab(page, 'Дневник')
  await page.context().setOffline(true)
  await diary.getByTestId('diary-mood-3').click()
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await page.context().setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).today?.mood, { timeout: 20_000 })
    .toBe(3)
})

test('дневник: сегменты «Дневник» и «Журнал»; последний открытый помнится', async ({ page, shot }) => {
  test.setTimeout(120_000)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  await expect(page.getByTestId('diary-segment-diary')).toHaveAttribute('aria-checked', 'true')
  // Two segments: the year and the recaps are not in the diary, the tests come later.
  await expect(page.locator('.page-current [data-testid^="diary-segment-"]')).toHaveCount(2)
  await expect(page.getByTestId('diary-year-card')).toHaveCount(0)

  await page.getByTestId('diary-segment-journal').click()
  await expect(page.getByTestId('diary-segment-journal')).toHaveAttribute('aria-checked', 'true')
  // A new account has no conversations yet.
  await expect(page.locator('.page-current').getByText('Здесь появятся твои разговоры.')).toBeVisible()
  await shot(page, 'diary-journal-empty')

  // The last segment is remembered for the next opening of the tab.
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await openTab(page, 'Дневник')
  await expect(page.getByTestId('diary-segment-journal')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.page-current').getByText('Здесь появятся твои разговоры.')).toBeVisible()
})

test('три вкладки помещаются на ширине 320px без обрезки подписей', async ({ page, shot }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await openApp(page)
  await startAnonymously(page)
  const labels = page.locator('#rd-tabbar .tab-link-text, #rd-tabbar .tabbar-label')
  await expect(labels).toHaveCount(3)
  for (const label of await labels.all()) {
    const fits = await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    expect(fits, `подпись «${await label.textContent()}» обрезана`).toBe(true)
  }
  const bar = await page.locator('#rd-tabbar').boundingBox()
  expect(bar!.x).toBeGreaterThanOrEqual(0)
  expect(bar!.x + bar!.width).toBeLessThanOrEqual(320)
  await shot(page, 'diary-tabs-320')
})

test('первый текст недели пишется сам, потом — «Обновить итоги» и автоматическая перезапись после паузы', async ({ page, request, shot }) => {
  test.setTimeout(900_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  const diary = page.locator('.page-current[data-name="diary"]')
  await diary.getByTestId('diary-mood-1').click()
  await expect.poll(async () => (await serverDiary(request, session.accessToken())).today?.mood).toBe(1)

  // Three more marked days of the same week, written straight to the table (the API takes only today and yesterday).
  const { week } = await serverDiary(request, session.accessToken())
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(week.start) + i * 86_400_000).toISOString().slice(0, 10))
  await seedMarks(
    session.userId(),
    days.filter((d) => d !== today()).slice(0, 3).map((date) => ({ date, mood: 1 as const })),
  )
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  // Four days: no button, the text is being written in the background (a minute after the last tap, then the minute tick).
  await expect(diary.getByTestId('diary-week-busy')).toBeVisible({ timeout: 15_000 })
  await expect(diary.getByTestId('diary-week-refresh')).toHaveCount(0)
  await expect(diary.getByTestId('diary-week-waiting')).toHaveCount(0)
  await shot(page, 'diary-week-building')
  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).week.summary?.text ?? '', { timeout: 180_000, intervals: [5_000] })
    .toContain('Тяжёлых дней было 4')
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  await expect(diary.getByTestId('diary-week-text')).toContainText('Тяжёлых дней было 4')
  await expect(diary.getByTestId('diary-week-busy')).toHaveCount(0)
  await expect(diary.getByTestId('diary-week-people')).toHaveCount(0)
  await shot(page, 'diary-week-summary')

  // The first text is written; «Обновить итоги» is there now. A change of mood does NOT rewrite it by itself within the six hours.
  await expect(diary.getByTestId('diary-week-refresh')).toBeVisible()
  await diary.getByTestId('diary-mood-4').click()
  await expect.poll(async () => (await serverDiary(request, session.accessToken())).today?.mood).toBe(4)
  await page.waitForTimeout(150_000)
  expect((await serverDiary(request, session.accessToken())).week.summary?.text).toContain('Тяжёлых дней было 4')

  // The button rewrites it at once; the old text stays under «Собираю итоги…» until the new one is there.
  await diary.getByTestId('diary-week-refresh').click()
  await expect(diary.getByTestId('diary-week-text')).toContainText('Тяжёлых дней было 3', { timeout: 30_000 })
  await expect(diary.getByTestId('diary-week-busy')).toHaveCount(0)
  await shot(page, 'diary-week-rewritten')
  // And once more within ten minutes: the friendly refusal.
  await diary.getByTestId('diary-week-refresh').click()
  await expect(diary.getByTestId('diary-week-error')).toContainText('Подожди немного')

  // After the six-hour gap (aged in the table) a changed mood is rewritten by the background pass alone.
  await diary.getByTestId('diary-mood-2').click()
  await expect.poll(async () => (await serverDiary(request, session.accessToken())).today?.mood).toBe(2)
  await ageWeekSummary(session.userId())
  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).week.summary?.text ?? '', { timeout: 180_000, intervals: [5_000] })
    .toContain('лёгких — 0')
})

test('итоги прошлой недели: карточка появляется, когда планировщик закрыл неделю', async ({ page, request, shot }) => {
  test.setTimeout(240_000)
  // By design the weekly tick does nothing before 06:00 local time on Monday (REQ-WELL-03), so the card cannot appear then.
  const moscow = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
  const part = (type: string) => moscow.find((p) => p.type === type)?.value
  test.skip(part('weekday') === 'Mon' && Number(part('hour')) < 6, 'до 06:00 в понедельник по Москве планировщик итоги недели не считает')
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  const diary = page.locator('.page-current[data-name="diary"]')
  await expect(diary.getByTestId('diary-today-title')).toBeVisible()
  await expect(diary.getByTestId('diary-previous-week')).toHaveCount(0)

  // Three marked days of the last finished week: the minute tick closes it with a final summary (agent mock: fixed text).
  const { week } = await serverDiary(request, session.accessToken())
  const lastMonday = new Date(Date.parse(week.start) - 7 * 86_400_000)
  const days = [0, 1, 2].map((i) => new Date(lastMonday.getTime() + i * 86_400_000).toISOString().slice(0, 10))
  await seedMarks(session.userId(), days.map((date) => ({ date, mood: 3 as const })))

  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).previousWeek?.text ?? '', { timeout: 150_000, intervals: [5_000] })
    .not.toBe('')
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  await expect(diary.getByTestId('diary-previous-week')).toContainText('Итоги прошлой недели')
  await shot(page, 'diary-previous-week')
})
