import { APP_URL } from '../playwright.config'
import { clearMailbox } from '../support/mail'
import { seedMarks } from '../support/diary'
import { trackSession } from '../support/session'
import { expect, test } from '../support/fixtures'
import {
  closeSidebar,
  nav,
  openSidebar,
  openWebApp,
  registerAndConfirm,
  uniqueEmail,
} from '../support/web'

/**
 * Дневник настроения в вебе (`REQ-WELL-01`, `openspec/changes/add-mood-diary`): отметка
 * в два касания, «передумал», мост к разговору, график, сегмент «Журнал» (бывший отдельный раздел) и перенос со старого адреса `/journal`. Один сценарий на одну регистрацию, как в остальных
 * web-спеках. Итоги недели, которые пишутся в фоне от трёх отмеченных дней, проверяются отдельным сценарием (нужны данные за прошлые дни).
 */
test('дневник: отметка в два касания, график, мост, журнал внутри дневника', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-diary'))

  // ── в сайдбаре есть «Дневник», страница открывается на сегменте «Дневник» ──
  await openSidebar(page)
  const diaryLink = nav(page).getByRole('link', { name: 'Дневник', exact: true })
  await expect(diaryLink).toBeVisible()
  await diaryLink.click()
  await expect(page).toHaveURL(/\/diary$/)
  await expect(page).toHaveTitle('Дневник — Рядом')

  // Первый вход: «Как ты сегодня?», пять уровней, пустой график, подсказка итогов недели.
  await expect(page.getByTestId('diary-today-title')).toHaveText('Как ты сегодня?')
  for (const level of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`diary-mood-${level}`)).toBeVisible()
  await expect(page.getByTestId('diary-chart-empty')).toHaveText('Отмечай настроение каждый день — здесь появится график')
  await expect(page.getByTestId('diary-week-hint')).toContainText('(сейчас: 0 из 3)')
  await expect(page.getByTestId('diary-streak')).toHaveCount(0)
  // The events of the week do not live on this page, and memory is not mentioned.
  await expect(page.getByTestId('diary-events-card')).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText(/События|памят/i)
  // The block «Самопроверка» and the segment «Тесты» are always there (add-self-check-tests).
  await expect(page.getByTestId('self-check-block')).toBeVisible()
  await expect(page.getByTestId('diary-segment-tests')).toBeVisible()
  await shot(page, 'web-diary-empty')

  // ── два касания: «Нормально», затем «Работа» ──────────────────────────────
  await page.getByTestId('diary-mood-3').click()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await expect(page.getByTestId('diary-mood-3')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('diary-mood-1')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('diary-factor-work').click()
  // The strip folds into «Повлияло: работа»; the counter of days in a row shows 1.
  await expect(page.getByTestId('diary-factor-summary')).toHaveText('Повлияло: работа')
  await expect(page.getByTestId('diary-factors')).toHaveCount(0)
  await expect(page.getByTestId('diary-streak')).toContainText('1 дн.')
  await expect(page.getByTestId('diary-bridge')).toHaveCount(0)

  // Отметка уже на сервере: после перезагрузки она на месте, на графике одна точка за сегодня.
  await page.reload()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await expect(page.getByTestId('diary-factor-summary')).toHaveText('Повлияло: работа')
  await expect(page.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(page.getByTestId('diary-chart-point')).toHaveAttribute('data-mood', '3')
  // 28-day window: seven columns at least, today in the circle, Saturday and Sunday shaded.
  await expect(page.getByTestId('diary-chart-today')).toBeVisible()
  await expect(page.getByTestId('diary-chart').getByRole('img', { name: /отмечен/ })).toBeVisible()
  await expect(page.getByTestId('diary-week-hint')).toContainText('(сейчас: 1 из 3)')
  await shot(page, 'web-diary-marked')

  // ── передумал: «Хорошо» заменяет отметку, фактор остаётся, точка по-прежнему одна ──
  await page.getByTestId('diary-mood-4').click()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: хорошо')
  await expect(page.getByTestId('diary-factor-summary')).toHaveText('Повлияло: работа')
  await expect(page.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(page.getByTestId('diary-chart-point')).toHaveAttribute('data-mood', '4')
  // Касание строки «Повлияло» открывает ленту; повторное касание фактора снимает его.
  await page.getByTestId('diary-factor-summary').click()
  await expect(page.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('diary-factor-work').click()
  await expect(page.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('diary-factor-work').click()

  // ── мост к разговору после «Так себе» ─────────────────────────────────────
  await page.getByTestId('diary-mood-2').click()
  await expect(page.getByTestId('diary-bridge')).toContainText('Хочешь рассказать, что случилось?')
  await shot(page, 'web-diary-bridge')
  await page.getByTestId('diary-mood-5').click()
  await expect(page.getByTestId('diary-bridge')).toHaveCount(0)
  await page.getByTestId('diary-mood-2').click()
  await page.getByTestId('diary-bridge-talk').click()
  await expect(page).toHaveURL(/\/home$/)

  await openWebApp(page, '/diary')

  // ── сегмент «Журнал» внутри дневника: пустой журнал, сайдбар отмечает «Дневник» ──
  await page.getByTestId('diary-segment-journal').click()
  await expect(page).toHaveURL(/\/diary\/journal$/)
  await expect(page.getByTestId('journal-empty')).toContainText('Здесь появятся твои разговоры')
  await expect(page.getByTestId('diary-segment-journal')).toHaveAttribute('aria-current', 'page')
  await shot(page, 'web-diary-journal')

  await openSidebar(page)
  await expect(nav(page).getByRole('link', { name: 'Дневник', exact: true })).toHaveAttribute('aria-current', 'page')
  await closeSidebar(page)

  // ── старый адрес журнала ведёт в дневник ─────────────────────────────────
  await openWebApp(page, '/journal')
  await expect(page).toHaveURL(/\/diary\/journal$/)
})

test('дневник: первый текст недели пишется сам, «Обновить итоги» переписывает сразу', async ({ page, request, shot }) => {
  test.setTimeout(420_000)
  await clearMailbox()
  const session = trackSession(page)
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-diary-week'))
  await openWebApp(page, '/diary')
  await page.getByTestId('diary-mood-1').click()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: тяжело')

  const read = async () => {
    const response = await request.get(`${APP_URL}/api/diary`, { headers: { Authorization: `Bearer ${session.accessToken()}` } })
    return ((await response.json()) as { result: { week: { start: string; summary: { text: string } | null }; today: { mood: number } | null } }).result
  }
  await expect.poll(async () => (await read()).today?.mood).toBe(1)
  const { week } = await read()
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(week.start) + i * 86_400_000).toISOString().slice(0, 10))
  await seedMarks(session.userId(), days.filter((d) => d !== today).slice(0, 3).map((date) => ({ date, mood: 1 as const })))

  await openWebApp(page, '/diary')
  await expect(page.getByTestId('diary-week-busy')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('diary-week-refresh')).toHaveCount(0)
  await shot(page, 'web-diary-week-building')
  await expect
    .poll(async () => (await read()).week.summary?.text ?? '', { timeout: 180_000, intervals: [5_000] })
    .toContain('Тяжёлых дней было 4')
  await openWebApp(page, '/diary')
  await expect(page.getByTestId('diary-week-text')).toContainText('Тяжёлых дней было 4')
  await expect(page.getByTestId('diary-week-people')).toHaveCount(0)
  await shot(page, 'web-diary-week-summary')

  // «Обновить итоги» is there once a text exists; a change of mood is rewritten by the button at once (not by the six-hour pass).
  await expect(page.getByTestId('diary-week-refresh')).toBeVisible()
  await page.getByTestId('diary-mood-4').click()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: хорошо')
  await expect.poll(async () => (await read()).today?.mood).toBe(4)
  await page.getByTestId('diary-week-refresh').click()
  await expect(page.getByTestId('diary-week-text')).toContainText('Тяжёлых дней было 3', { timeout: 30_000 })
  await shot(page, 'web-diary-week-rewritten')
  await page.getByTestId('diary-week-refresh').click()
  await expect(page.getByTestId('diary-week-error')).toContainText('Подожди немного')
})
