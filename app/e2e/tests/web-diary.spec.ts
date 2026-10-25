import { clearMailbox } from '../support/mail'
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
 * в два касания, «передумал», мост к разговору, график, «Год в пикселях» с подписью клетки и картинка «Поделиться моим годом». Один сценарий на одну регистрацию, как в остальных
 * web-спеках. Итоги недели от трёх отмеченных дней проверяются отдельно (нужны данные за прошлые дни).
 */
test('дневник: отметка в два касания, график, мост, год и «Поделиться»', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await clearMailbox()
  // Headless Chromium on desktop has no file sharing: the picture must fall back to a download.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true })
  })
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
  await expect(page.getByTestId('diary-week-hint')).toContainText('(сейчас: 0)')
  await expect(page.getByTestId('diary-week-collect')).toHaveCount(0)
  await expect(page.getByTestId('diary-events-card')).toBeVisible()
  await shot(page, 'web-diary-empty')

  // ── два касания: «Нормально», затем «Работа» ──────────────────────────────
  await page.getByTestId('diary-mood-3').click()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await expect(page.getByTestId('diary-mood-3')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('diary-mood-1')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('diary-factor-work').click()
  await expect(page.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('diary-bridge')).toHaveCount(0)

  // Отметка уже на сервере: после перезагрузки она на месте, на графике одна точка за сегодня.
  await page.reload()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: нормально')
  await expect(page.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(page.getByTestId('diary-chart-point')).toHaveAttribute('data-mood', '3')
  await expect(page.getByTestId('diary-chart').getByRole('img', { name: /отмечен/ })).toBeVisible()
  await expect(page.getByTestId('diary-week-hint')).toContainText('(сейчас: 1)')
  await shot(page, 'web-diary-marked')

  // ── передумал: «Хорошо» заменяет отметку, фактор остаётся, точка по-прежнему одна ──
  await page.getByTestId('diary-mood-4').click()
  await expect(page.getByTestId('diary-today-title')).toHaveText('Сегодня: хорошо')
  await expect(page.getByTestId('diary-factor-work')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('diary-chart-point')).toHaveCount(1)
  await expect(page.getByTestId('diary-chart-point')).toHaveAttribute('data-mood', '4')
  // Повторное касание фактора снимает его.
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

  // ── сегменты: «Итоги» — пустое состояние, «Год» — сетка ────────
  await page.getByTestId('diary-segment-recaps').click()
  await expect(page).toHaveURL(/\/diary\/recaps$/)
  await expect(page.getByTestId('diary-recaps-empty')).toContainText('Здесь будут итоги ваших разговоров')
  await page.getByTestId('diary-segment-year').click()
  await expect(page).toHaveURL(/\/diary\/year$/)

  const cells = page.getByTestId('diary-year-cell')
  await expect(cells).toHaveCount(365 + (isLeapYear(new Date().getFullYear()) ? 1 : 0))
  const marked = page.locator('[data-testid="diary-year-cell"]:not([data-mood=""])')
  await expect(marked).toHaveCount(1)
  await expect(page.getByTestId('diary-year-marked')).toContainText('1')
  await expect(page.getByTestId('diary-year-most')).toContainText('так себе')
  await marked.click()
  await expect(page.getByTestId('diary-year-caption')).toContainText('— так себе')
  await expect(page.getByTestId('diary-story-progress')).toHaveAttribute('aria-valuenow', '0')
  await shot(page, 'web-diary-year')

  // Сайдбар отмечает «Дневник» на любом сегменте.
  await openSidebar(page)
  await expect(nav(page).getByRole('link', { name: 'Дневник', exact: true })).toHaveAttribute('aria-current', 'page')
  await closeSidebar(page)

  // ── «Поделиться моим годом»: без отправки файлов картинка скачивается ─────
  const download = page.waitForEvent('download')
  await page.getByTestId('diary-year-share').click()
  expect((await download).suggestedFilename()).toBe(`ryadom-${new Date().getFullYear()}.png`)
})

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}
