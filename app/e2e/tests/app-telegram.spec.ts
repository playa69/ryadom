import { PWA_URL } from '../playwright.config'
import { button, checkConsent, field, openTab } from '../support/app'
import { profileOf, storedDevice, trackSession } from '../support/session'
import { telegramLaunchUrl, uniqueTelegramId } from '../support/telegram'
import { expect, test } from '../support/fixtures'

/**
 * The PWA as the Telegram Mini App: the person is their Telegram user. The launch is made by hand
 * (support/telegram.ts), signed with the bot token the e2e API runs with, so the client takes the same
 * path it takes inside Telegram: Telegram's script loads, the first screen makes an account for the
 * Telegram user after the agreements, and a later launch opens it without a screen.
 */

const profileEmail = (page: import('@playwright/test').Page) =>
  page.locator('.page-current').locator('.rd-profile-email')

test('Mini App: аккаунт пользователя Telegram, повторный запуск без экранов, выход и вход через Telegram', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const launch = telegramLaunchUrl(PWA_URL, { id: uniqueTelegramId(), first_name: 'Аня' })

  // ── first launch: the first screen, with the name from Telegram offered ─
  await page.goto(launch)
  await expect(button(page, 'Начать')).toBeVisible({ timeout: 30_000 })
  await expect(field(page, 'name')).toHaveValue('Аня')
  await expect(page.getByText(/Аккаунт привязан к твоему Telegram/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Скрыть' }), 'баннера установки в Telegram нет').toHaveCount(0)
  expect(await page.evaluate(() => Boolean((window as { Telegram?: unknown }).Telegram)), 'скрипт Telegram загружен').toBe(
    true,
  )
  await shot(page, 'app-telegram-welcome')

  await field(page, 'name').fill('Аня Т')
  await checkConsent(page)
  await button(page, 'Начать').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  const accountId = session.userId()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email: null,
    name: 'Аня Т',
    telegramLinked: true,
    consentsCompleted: true,
  })
  expect(await storedDevice(page), 'удостоверение устройства не нужно').toBeNull()

  // ── the profile: not a guest, the way in is Telegram ─
  await openTab(page, 'Профиль')
  await expect(profileEmail(page)).toHaveText('Вход через Telegram')
  await expect(page.getByText('Выйти из аккаунта')).toBeVisible()
  await expect(page.getByText(/дней после последнего визита/)).toHaveCount(0)
  await shot(page, 'app-telegram-profile')

  // ── a new launch with no session on the device: straight in, the same account ─
  await page.evaluate(() => localStorage.clear())
  await page.goto('about:blank')
  await page.goto(launch)
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  expect(session.userId(), 'тот же аккаунт').toBe(accountId)

  // ── signing out: no silent sign-in until the Mini App is closed; Telegram is one button away ─
  await openTab(page, 'Профиль')
  await button(page, 'Выйти из аккаунта').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(button(page, 'Войти через Telegram')).toBeVisible({ timeout: 20_000 })
  await page.reload()
  await expect(button(page, 'Войти через Telegram'), 'после перезагрузки не входит сам').toBeVisible({ timeout: 30_000 })
  await button(page, 'Войти через Telegram').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  expect(session.userId(), 'вход через Telegram — в тот же аккаунт').toBe(accountId)
})

test('обычная вкладка: скрипт Telegram не загружается', async ({ page }) => {
  await page.goto(`${PWA_URL}/`)
  await expect(button(page, 'Начать').or(button(page, 'Поговорить'))).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => 'Telegram' in window)).toBe(false)
})
