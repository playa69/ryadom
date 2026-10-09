import {
  button,
  checkConsent,
  closeSheet,
  field,
  openApp,
  openTab,
  PASSWORD,
  registerAndConfirm,
  signIn,
  uniqueEmail,
} from '../support/app'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

/**
 * The whole account path: sign-up, the code from the email, SOS, password change, deletion.
 * Everything the app store policies require is checked here.
 *
 * One scenario rather than five tests: every test would open its own session and sign in again,
 * and sign-in is rate limited per address, so the suite would run into its own brute-force
 * protection.
 */
test('путь аккаунта: регистрация, вход, смена пароля, удаление', async ({ page, shot }) => {
  const email = uniqueEmail('account')
  await clearMailbox()

  // ── sign-up ──────────────────────────────────────────────────────────────
  await openApp(page)
  await shot(page, 'app-welcome')
  await registerAndConfirm(page, email)
  await shot(page, 'app-home')

  // ── SOS: help lines in one tap ───────────────────────────────────────────
  await page.getByRole('button', { name: 'SOS' }).click()
  await expect(page.getByText('Если сейчас тяжело')).toBeVisible()
  await expect(page.getByRole('link', { name: /112/ })).toBeVisible()
  await shot(page, 'app-sos')
  await closeSheet(page)

  // ── password change ──────────────────────────────────────────────────────
  await openTab(page, 'Профиль')
  await shot(page, 'app-profile')

  // The agent's voice: a man's until the person picks another one; the choice is saved on the account.
  const male = page.getByTestId('voice-male')
  const female = page.getByTestId('voice-female')
  await expect(male).toHaveClass(/button-active/)
  await expect(female).not.toHaveClass(/button-active/)
  await female.click()
  await expect(page.getByText('Голос сохранён')).toBeVisible()
  await expect(female).toHaveClass(/button-active/)
  await expect(male).not.toHaveClass(/button-active/)

  await page.getByText('Изменить пароль', { exact: true }).click()

  const nextPassword = `${PASSWORD}-new`
  await field(page, 'current-password').fill(PASSWORD)
  await field(page, 'new-password').fill(nextPassword)
  await field(page, 'repeat-password').fill(nextPassword)
  await button(page, 'Изменить пароль').click()
  // Changing the password does not sign the person out: the screen returns to the profile.
  await expect(page.getByText('Пароль изменён')).toBeVisible({ timeout: 20_000 })

  // Check the new password for real: sign out and sign in again.
  await button(page, 'Выйти из аккаунта').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 20_000 })
  await signIn(page, email, nextPassword)

  // ── account deletion ─────────────────────────────────────────────────────
  await openTab(page, 'Профиль')
  await page.getByText('Стереть всё и удалить аккаунт').click()
  await expect(page.getByText('Это действие необратимо')).toBeVisible()
  await shot(page, 'app-delete-account')

  await checkConsent(page)
  await button(page, 'Удалить аккаунт').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(page.getByText('Аккаунт и все разговоры удалены')).toBeVisible({ timeout: 30_000 })
  await page.locator('.dialog.modal-in').getByText('ОК').click()

  // A deleted account no longer lets anyone in.
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 20_000 })
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(nextPassword)
  await button(page, 'Войти').click()
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 20_000 })
})
