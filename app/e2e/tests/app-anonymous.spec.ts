import { ANONYMOUS_RETENTION_DAYS, POLICY_VERSION } from '@ryadom/contracts/api/policy'
import {
  button,
  checkConsent,
  field,
  openApp,
  openTab,
  PASSWORD,
  signIn,
  startAnonymously,
  uniqueEmail,
} from '../support/app'
import { clearMailbox, waitForCode } from '../support/mail'
import { deviceLogin, profileOf, sessionAlive, storedDevice, trackSession } from '../support/session'
import { expect, test } from '../support/fixtures'

/**
 * Anonymous entry in the Framework7 client (the PWA), the counterpart of web-anonymous.spec.ts: the
 * first screen with the three agreements, an account behind it, and the profile that offers an
 * address where it has something to give.
 *
 * One scenario for the account's life and a short one for its end, for the reason the other
 * account scenarios give: every test would start its own session, and the entry points are rate
 * limited per address.
 */

const profileEmail = (page: import('@playwright/test').Page) =>
  page.locator('.page-current').locator('.rd-profile-email')

/** The row has a line of explanation under its title, so its text is not the title alone: it is found by role. */
const linkRow = (page: import('@playwright/test').Page) =>
  page.locator('.page-current').getByRole('link', { name: /Привязать почту/ })

test('первый запуск, привязка почты, выход: аккаунт без почты живёт сам, с почтой — по паролю', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const email = uniqueEmail('app-anonymous')
  await clearMailbox()

  // ── a new visitor: the first screen, not a sign-in ───────────────────────
  await openApp(page)
  await expect(page.locator('.page-current').getByTestId('consents')).toBeVisible()
  await shot(page, 'app-welcome')
  await button(page, 'Начать').click()
  await expect(page.getByTestId('form-error')).toHaveText('Чтобы начать, нужны все три согласия')
  expect(await storedDevice(page), 'пока согласий нет, удостоверения нет').toBeNull()

  await startAnonymously(page)
  const accountId = session.userId()
  expect(await storedDevice(page), 'удостоверение устройства сохранено').not.toBeNull()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email: null,
    consentsCompleted: true,
    consentVersion: POLICY_VERSION,
  })

  // ── the profile offers an address, not a password, and says how long the account lives ─
  await openTab(page, 'Профиль')
  await expect(profileEmail(page)).toHaveText('Без регистрации')
  await expect(linkRow(page)).toBeVisible()
  await expect(page.getByText('Изменить пароль', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Выйти из аккаунта'), 'выхода из такого аккаунта нет').toHaveCount(0)
  await expect(page.getByText('Войти в другой аккаунт', { exact: true })).toBeVisible()
  await expect(
    page.getByText(new RegExp(`${ANONYMOUS_RETENTION_DAYS} дней после последнего визита`)),
  ).toBeVisible()
  await shot(page, 'app-anonymous-profile')

  // ── the session is gone but the key is on the phone: the app signs back in without a screen ─
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (!/device|memory-invite/.test(key)) localStorage.removeItem(key)
  })
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  expect(session.userId(), 'тот же аккаунт, не новый').toBe(accountId)

  // ── linking: the form, then the code from the email ──────────────────────
  await openTab(page, 'Профиль')
  await linkRow(page).click()
  await expect(page.getByText(new RegExp(`удаляется через ${ANONYMOUS_RETENTION_DAYS} дней`))).toBeVisible()
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(PASSWORD)
  await shot(page, 'app-anonymous-link-email')
  await button(page, 'Отправить код').click()
  await expect(page.getByText('Подтверди почту')).toBeVisible({ timeout: 20_000 })
  const codeField = page.getByRole('textbox', { name: 'Код из письма' })
  await codeField.fill('000000')
  await expect(page.getByTestId('form-error')).toContainText('Код не подошёл', { timeout: 20_000 })
  // The boxes submit when the sixth digit arrives: after a refusal they are emptied first, as a person does.
  await codeField.fill('')
  await codeField.fill(await waitForCode(email))

  // ── now it is an ordinary account: a password, a way out, and no key on the phone ─
  await expect(profileEmail(page)).toHaveText(email, { timeout: 30_000 })
  await expect(page.getByText('Изменить пароль', { exact: true })).toBeVisible()
  await expect(linkRow(page)).toHaveCount(0)
  await expect(page.getByText('Войти в другой аккаунт', { exact: true })).toHaveCount(0)
  await expect(button(page, 'Выйти из аккаунта')).toBeVisible()
  expect(await storedDevice(page), 'ключ устройства забыт: у аккаунта есть пароль').toBeNull()
  await shot(page, 'app-anonymous-linked')

  // ── signing out really signs out: the next launch is a stranger's, the way back is the address ─
  const ended = session.refreshToken()
  await button(page, 'Выйти из аккаунта').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 20_000 })
  expect(await sessionAlive(request, ended), 'сессия завершена на сервере').toBe(false)
  await openApp(page)
  await expect(button(page, 'Начать')).toBeVisible()
  await page.locator('.page-current').getByTestId('have-account').click()
  await signIn(page, email)
  expect(session.userId(), 'тот же аккаунт со всем, что в нём было').toBe(accountId)
})

test('удаление аккаунта без регистрации: устройство забыто, дальше — первый экран и новый аккаунт', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const session = trackSession(page)

  await openApp(page)
  await startAnonymously(page)
  const oldAccount = session.userId()
  const oldDevice = (await storedDevice(page))!
  const oldSession = session.refreshToken()
  expect(oldDevice).not.toBeNull()

  await openTab(page, 'Профиль')
  await page.getByText('Стереть всё и удалить аккаунт').click()
  await expect(page.getByText('Удаляется аккаунт без регистрации')).toBeVisible()
  // Two consequences, not three: there is no address to free.
  await expect(page.getByText('Профиль удаляется. Восстановить аккаунт будет нельзя.')).toBeVisible()
  await expect(page.getByText('Почта освободится')).toHaveCount(0)
  await checkConsent(page)
  await button(page, 'Удалить аккаунт').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(page.getByText('Аккаунт и все разговоры удалены')).toBeVisible({ timeout: 30_000 })
  await page.locator('.dialog.modal-in').getByText('ОК').click()

  // Back at the start, not at a sign-in for an account the person never had.
  await expect(button(page, 'Начать')).toBeVisible({ timeout: 20_000 })
  expect(await storedDevice(page), 'ключ устройства стёрт вместе с аккаунтом').toBeNull()
  expect(await sessionAlive(request, oldSession), 'сессия удалённого аккаунта закончена').toBe(false)

  // The old key no longer leads to the old account, and the same phone starts over with a key of its own.
  expect((await deviceLogin(request, oldDevice)).isNewAccount).toBe(true)
  await startAnonymously(page)
  expect(session.userId()).not.toBe(oldAccount)
  expect((await storedDevice(page))!.deviceId).not.toBe(oldDevice.deviceId)
})
