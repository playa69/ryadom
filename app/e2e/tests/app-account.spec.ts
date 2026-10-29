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
import { step } from '../support/evidence'
import { setVoicePipeline } from '../support/voice'

/**
 * The whole account path: sign-up, the code from the email, SOS, password change, deletion.
 * Everything the app store policies require is checked here.
 *
 * One scenario rather than five tests: every test would open its own session and sign in again,
 * and sign-in is rate limited per address, so the suite would run into its own brute-force
 * protection.
 */
// The voice path is global: put the default back whatever the test did with it.
test.afterEach(() => setVoicePipeline(null))

test('путь аккаунта: регистрация, вход, смена пароля, удаление', async ({ page, shot }) => {
  // The choice of a voice is Gemini Live's; the Sber path is checked further down.
  await setVoicePipeline('gemini')
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
  await expect(page.getByTestId('voice-name')).toContainText('Дмитрий')
  await page.getByTestId('voice-name').click()
  // The voice page opens on the tab of the current gender; a tap on a voice's ▶ plays it and does not choose it.
  await expect(page.locator('.segmented')).toBeVisible()
  await step(page, 'voice-male-tab', 'Страница «Голос агента»: открыта на мужских голосах')
  await page.locator('.segmented .button', { hasText: 'Женские' }).click()
  await step(page, 'voice-female-tab', 'Вкладка женских голосов: у каждого можно прослушать пример')
  await page.getByLabel('Прослушать: Алиса').click()
  await expect(page.locator('input[name=voice]:checked')).toHaveCount(0) // the chosen one is on the other tab
  await page.locator('.item-title', { hasText: 'Алиса' }).click()
  await expect(page.getByText('Голос сохранён')).toBeVisible()
  await expect(page.locator('input[name=voice]:checked')).toHaveValue('Zephyr')
  await step(page, 'voice-saved', 'Выбрана Алиса: «Голос сохранён»')
  await page.locator('.navbar a.back').click()
  await expect(page.getByTestId('voice-name')).toContainText('Алиса')
  await step(page, 'voice-profile', 'В профиле теперь голос Алиса')

  // `openspec/changes/add-sber-voice-pipeline`, «Выбор голоса агента»: on the Sber path the profile, read again,
  // names the one voice that speaks, and the choice is kept for Gemini Live.
  await setVoicePipeline('sber')
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await openTab(page, 'Профиль')
  await expect(page.getByTestId('voice-name')).toContainText('Вера')
  await page.getByTestId('voice-name').click()
  await expect(page.getByTestId('voice-single-note')).toContainText('Твой выбор, Алиса, сохранён')
  await expect(page.locator('.segmented')).toHaveCount(0)
  await expect(page.getByLabel('Прослушать: Вера')).toBeVisible()
  await step(page, 'voice-sber', 'Путь Сбера: на странице один голос — Вера, выбранная Алиса сохранена')
  await page.locator('.navbar a.back').click()
  await setVoicePipeline('gemini')
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await openTab(page, 'Профиль')
  await expect(page.getByTestId('voice-name')).toContainText('Алиса')

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
