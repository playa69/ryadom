import type { APIRequestContext } from '@playwright/test'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import type { NotificationSettingsApiResponse } from '@ryadom/contracts/api/notifications'
import { APP_URL } from '../playwright.config'
import { button, openApp, openTab, startAnonymously } from '../support/app'
import { expect, test } from '../support/fixtures'
import { trackSession } from '../support/session'
// Written by the server side of the change (a direct write to the table: the API takes only today and yesterday).
import { seedMarks } from '../support/diary'

/**
 * The mood diary in the app (PWA), `REQ-WELL-01`…`04`: the card in two taps, a change of mind, the chart,
 * the bridge to a conversation, a note made without a network, the year, the reminder question that asks
 * nothing of the system until «Да», and the week summary after three marked days (agent mock: fixed text).
 */

/** The day in the browser's zone (the config sets Europe/Moscow), as the diary counts it. */
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })

async function notificationSettings(request: APIRequestContext, accessToken: string) {
  const response = await request.get(`${APP_URL}/api/notifications/settings`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  expect(response.status(), 'настройки напоминаний').toBe(200)
  return ((await response.json()) as { result: NotificationSettingsApiResponse }).result
}

async function serverDiary(request: APIRequestContext, accessToken: string) {
  const response = await request.get(`${APP_URL}/api/diary`, { headers: { Authorization: `Bearer ${accessToken}` } })
  expect(response.status(), 'дневник на сервере').toBe(200)
  const body = (await response.json()) as { status: boolean; result: DiaryApiResponse }
  return body.result
}

test('дневник: пустой → отметка в два касания → передумал → график → мост → без сети', async ({ page, request, shot }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await page.addInitScript(() => {
    const w = window as unknown as { __permissionAsks: number }
    w.__permissionAsks = 0
    const original = Notification.requestPermission.bind(Notification)
    Notification.requestPermission = (...args: Parameters<typeof original>) => {
      w.__permissionAsks += 1
      return original(...args)
    }
  })
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')

  const diary = page.locator('.page-current[data-name="diary"]')
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Как ты сегодня?')
  await expect(diary.getByTestId('diary-chart-empty')).toContainText('здесь появится график')
  await expect(diary.getByTestId('diary-week-waiting')).toContainText('(сейчас: 0)')
  await expect(diary.getByTestId('diary-selfcheck')).toBeVisible()
  await expect(diary.getByTestId('diary-events-card')).toBeVisible()
  // The question comes first; the system asks for nothing until «Да».
  await expect(diary.getByTestId('diary-reminder-offer')).toContainText('Напоминать вечером, в 20:00?')
  // Nothing has asked the system for the permission yet (the headless browser reports `denied` either way).
  expect(await page.evaluate(() => (window as unknown as { __permissionAsks: number }).__permissionAsks)).toBe(0)
  await shot(page, 'diary-empty')

  // ── two taps ─────────────────────────────────────────────────────────────────────────────
  await diary.getByTestId('diary-mood-3').click()
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await expect(diary.getByTestId('diary-factors')).toContainText('Что повлияло больше всего?')
  await diary.getByTestId('diary-factor-work').click()
  await expect(diary.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await expect(diary.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(diary.getByTestId('diary-chart')).toHaveAttribute('aria-label', /отмечен[о]? 1 день, чаще всего — нормально/)
  await expect(diary.getByTestId('diary-week-waiting')).toContainText('(сейчас: 1)')
  await shot(page, 'diary-marked')

  // The server has it, so another device of the person sees it too.
  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).today)
    .toEqual({ mood: 3, factor: 'work' })

  // ── a change of mind: the day keeps one note and the factor ──────────────────────────────
  await diary.getByTestId('diary-mood-4').click()
  await expect(diary.getByTestId('diary-today-title')).toHaveText('Сегодня: хорошо')
  await expect(diary.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await expect(diary.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(diary.getByTestId('diary-chart-point')).toHaveAttribute('data-mood', '4')
  // The same factor again takes it off.
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

test('дневник: сегменты — итоги, год, тесты; год в пикселях и «Поделиться»', async ({ page, request, shot }) => {
  test.setTimeout(120_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  const diary = page.locator('.page-current[data-name="diary"]')
  await diary.getByTestId('diary-mood-3').click()
  await diary.getByTestId('diary-factor-work').click()
  await expect
    .poll(async () => (await serverDiary(request, session.accessToken())).today?.factor)
    .toBe('work')

  await diary.getByTestId('diary-segment-recaps').click()
  const recaps = page.locator('.page-current[data-name="diary"]')
  await expect(recaps.getByTestId('diary-recaps-empty')).toContainText('Здесь будут итоги ваших разговоров')
  await recaps.getByTestId('diary-segment-tests').click()
  await expect(page.locator('.page-current').getByTestId('diary-tests-soon')).toBeVisible()

  await page.locator('.page-current').getByTestId('diary-segment-year').click()
  const year = page.locator('.page-current[data-name="diary"]')
  await expect(year.getByTestId('diary-year-card')).toContainText('Каждый квадратик — один день')
  await expect(year.getByTestId('diary-year-cell')).toHaveCount(365 + (new Date().getFullYear() % 4 === 0 ? 1 : 0))
  const cell = year.locator(`[data-testid="diary-year-cell"][data-date="${today()}"]`)
  await expect(cell).toHaveAttribute('data-mood', '3')
  await expect(year.getByTestId('diary-year-marked')).toHaveText('Отмечено дней: 1')
  await expect(year.getByTestId('diary-year-top')).toHaveText('Чаще всего: нормально')
  await cell.click()
  await expect(year.getByTestId('diary-year-caption')).toContainText('— нормально · Работа')
  await expect(year.getByTestId('diary-story-card')).toContainText('Собрано 0 из 6')
  await shot(page, 'diary-year', { fullPage: true })

  // Without the system's file sharing the picture is downloaded.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    year.getByTestId('diary-year-share').click(),
  ])
  expect(download.suggestedFilename()).toBe(`ryadom-${new Date().getFullYear()}.png`)

  // The last segment is remembered for the next opening of the tab.
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await openTab(page, 'Дневник')
  await expect(page.locator('.page-current[data-name="diary"]').getByTestId('diary-year-card')).toBeVisible()
})

test('напоминание: «Да» без разрешения системы не меняет настройку на сервере', async ({ page, request }) => {
  test.setTimeout(120_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  const diary = page.locator('.page-current[data-name="diary"]')

  // The headless browser refuses the system prompt: the row says so, the setting stays as it was.
  await diary.getByTestId('diary-reminder-yes').click()
  await expect(diary.getByTestId('diary-reminder-blocked')).toContainText('Уведомления запрещены в настройках')
  const kept = await notificationSettings(request, session.accessToken())
  expect(kept.offerAnswered).toBe(true)
  expect(kept.moodReminder).toMatchObject({ enabled: true, time: '20:00' })
})

test('напоминание: «Не нужно» выключает его и больше не спрашивает', async ({ page, request, shot }) => {
  test.setTimeout(120_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  const diary = page.locator('.page-current[data-name="diary"]')
  await diary.getByTestId('diary-reminder-no').click()
  await expect(diary.getByTestId('diary-reminder-offer')).toHaveCount(0)
  await expect(diary.getByTestId('diary-reminder-row')).toContainText('Напоминать о настроении')
  await shot(page, 'diary-reminder-off')
  const settings = await notificationSettings(request, session.accessToken())
  expect(settings.offerAnswered).toBe(true)
  expect(settings.moodReminder.enabled).toBe(false)

  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await openTab(page, 'Дневник')
  await expect(page.locator('.page-current[data-name="diary"]').getByTestId('diary-reminder-row')).toBeVisible()
  await expect(page.getByTestId('diary-reminder-offer')).toHaveCount(0)
})

test('итоги недели: после трёх отмеченных дней — кнопка и текст агента; «Люди рядом» после тяжёлой недели', async ({ page, request, shot }) => {
  test.setTimeout(180_000)
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
  await expect(diary.getByTestId('diary-week-collect')).toBeVisible({ timeout: 15_000 })
  await shot(page, 'diary-week-ready')
  await diary.getByTestId('diary-week-collect').click()
  await expect(diary.getByTestId('diary-week-text')).toBeVisible({ timeout: 30_000 })
  await expect(diary.getByTestId('diary-week-collect')).toHaveCount(0)
  await expect(diary.getByTestId('diary-week-people')).toBeVisible()
  await shot(page, 'diary-week-summary')
})
