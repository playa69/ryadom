import { PWA_URL } from '../playwright.config'
import { button, consentSheet, field, openTab } from '../support/app'
import { profileOf, storedDevice, trackSession } from '../support/session'
import { telegramLaunchUrl, uniqueTelegramId } from '../support/telegram'
import { expect, test } from '../support/fixtures'
import { step } from '../support/evidence'

/**
 * The PWA as the Telegram Mini App: the person is their Telegram user. The launch is made by hand
 * (support/telegram.ts), signed with the bot token the e2e API runs with, so the client takes the same
 * path it takes inside Telegram: Telegram's script loads, home opens at once with no gate before it,
 * the first start asks for the agreements in a sheet and makes an account for the Telegram user, and a
 * later launch opens it without a screen.
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

  // ── first launch: home at once, the agreements in a sheet at the first start ─
  // `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии»: in the Mini App there is
  // no gate and no name field before home either.
  await page.goto(launch)
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await expect(field(page, 'name'), 'поля имени перед стартом больше нет').toHaveCount(0)
  await expect(page.locator('.page-current').getByTestId('hello-plaque')).toBeVisible()
  await step(page, 'tg-welcome', 'Первый вход в Telegram: сразу первый экран с шаром, без ворота согласия')
  await expect(page.getByRole('button', { name: 'Скрыть' }), 'баннера установки в Telegram нет').toHaveCount(
    0,
  )
  expect(
    await page.evaluate(() => Boolean((window as { Telegram?: unknown }).Telegram)),
    'скрипт Telegram загружен',
  ).toBe(true)
  await shot(page, 'app-telegram-welcome')

  // «Поговорить» asks for the agreements in a sheet over home; its «Продолжить» makes the account
  // and starts the conversation in one press.
  await button(page, 'Поговорить').click()
  const sheet = consentSheet(page)
  await expect(sheet).toBeVisible()
  await expect(sheet.getByTestId('data-consent-toggle')).not.toBeChecked()
  await expect(sheet.getByTestId('consent-continue')).toHaveClass(/disabled/)
  // The terms of the Telegram account are in the sheet, under the buttons.
  await expect(sheet.getByTestId('guest-note')).toContainText('Аккаунт привязан к твоему Telegram')
  await sheet.getByTestId('data-consent-toggle').check()
  const started = page.waitForRequest((r) => r.url().endsWith('/api/dialogs') && r.method() === 'POST')
  await sheet.getByTestId('consent-continue').click()
  // `openspec/changes/remove-unsaved-dialog-option`, «(Telegram) Активный экран после согласия».
  expect((await started).postDataJSON()).not.toHaveProperty('saved', false)
  await expect(page.getByText('Я рядом. С чего начнём?').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.page-current').getByTestId('dialog-unsaved')).toHaveCount(0)
  await step(
    page,
    'tg-voice',
    '«Продолжить» в листе согласия Telegram: аккаунт создан, разговор открыт, агент здоровается',
  )
  const accountId = session.userId()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email: null,
    telegramLinked: true,
    consentsCompleted: true,
  })
  expect(await storedDevice(page), 'удостоверение устройства не нужно').toBeNull()
  await page.locator('.page-current .navbar a.back').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.page-current').getByTestId('unsaved')).toHaveCount(0)

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
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  expect(session.userId(), 'тот же аккаунт').toBe(accountId)

  // ── signing out: no silent sign-in until the Mini App is closed; Telegram is one button away ─
  await openTab(page, 'Профиль')
  await button(page, 'Выйти из аккаунта').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(button(page, 'Войти через Telegram')).toBeVisible({ timeout: 20_000 })
  await page.reload()
  await expect(button(page, 'Войти через Telegram'), 'после перезагрузки не входит сам').toBeVisible({
    timeout: 30_000,
  })
  await button(page, 'Войти через Telegram').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  expect(session.userId(), 'вход через Telegram — в тот же аккаунт').toBe(accountId)
})

test('обычная вкладка: скрипт Telegram не загружается', async ({ page }) => {
  await page.goto(`${PWA_URL}/`)
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => 'Telegram' in window)).toBe(false)
})
