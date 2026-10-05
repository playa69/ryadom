import type { Page } from '@playwright/test'
import { button, openApp, openTab, registerAndConfirm, signIn, uniqueEmail } from '../support/app'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

/**
 * A person's own sessions in the Framework7 client (the PWA), the counterpart of web-sessions.spec.ts:
 * the list of devices, ending another one, and signing out everywhere. What the other device meets
 * is checked in the web scenario; here it is only that this client's screen and buttons work.
 */

const FIREFOX_ON_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'

const screen = (page: Page) => page.locator('.page-current')

test('устройства и сессии в PWA: список, завершение чужой, выход везде', async ({
  page,
  newDevice,
  shot,
}) => {
  test.setTimeout(240_000)
  const email = uniqueEmail('app-sessions')
  await clearMailbox()

  // ── two devices of one account ───────────────────────────────────────────
  await openApp(page)
  await registerAndConfirm(page, email)
  const other = await newDevice()
  await other
    .context()
    .route(/\/api\//, (route) =>
      route.fallback({ headers: { ...route.request().headers(), 'user-agent': FIREFOX_ON_LINUX } }),
    )
  await openApp(other)
  await screen(other).getByTestId('have-account').click()
  await signIn(other, email)

  // ── the list ─────────────────────────────────────────────────────────────
  await openTab(page, 'Профиль')
  await screen(page).getByTestId('row-sessions').click()
  await expect(screen(page).getByTestId('sessions-current')).toBeVisible()
  const others = screen(page).getByTestId('sessions-others').getByTestId('session-row')
  await expect(others).toHaveCount(1)
  await expect(others).toContainText('Firefox · Linux')
  await expect(screen(page).getByTestId('sessions-current').getByTestId('session-row')).toContainText(
    'Это устройство',
  )
  await shot(page, 'app-sessions')

  // ── ending the other device ──────────────────────────────────────────────
  await others.getByTestId('session-end').click()
  await expect(screen(page).getByTestId('sessions-none')).toHaveText('Других устройств нет.')

  // ── signing out everywhere takes this device too ─────────────────────────
  await screen(page).getByTestId('end-all').click()
  await page.locator('.dialog.modal-in').getByText('ОК').click()
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 30_000 })
})
