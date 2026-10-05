import type { Page } from '@playwright/test'
import {
  button,
  expectNoHorizontalOverflow,
  modal,
  modalButton,
  openProfile,
  openWebApp,
  registerAndConfirm,
  signIn,
  talkButton,
  uniqueEmail,
  watchCsp,
} from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

/**
 * A person's own sessions in the web app: the list of devices, ending another one, ending all the
 * others, signing out everywhere, and what the other device meets when its session is gone.
 *
 * One scenario, for the reason the account scenarios give: every sign-in counts against the
 * per-address limit. The second device is a browser context of its own, so it has a session of its own.
 */

const FIREFOX_ON_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'

/**
 * Makes a page say it is another browser. The server only knows a device by what it sends, and a
 * headless Chrome would show up as nothing readable. `fallback` hands the changed request on to the
 * handler of the fixtures, which adds the per-test address.
 */
async function presentAs(page: Page, userAgent: string): Promise<void> {
  await page
    .context()
    .route(/\/api\//, (route) =>
      route.fallback({ headers: { ...route.request().headers(), 'user-agent': userAgent } }),
    )
}

/** The second device signs in to the account. */
async function signInOn(device: Page, email: string): Promise<void> {
  await openWebApp(device)
  await expect(device).toHaveURL(/\/welcome$/)
  await device.getByTestId('have-account').click()
  await signIn(device, email)
}

async function openSessions(page: Page): Promise<void> {
  await openProfile(page)
  await page.getByTestId('row-sessions').click()
  await expect(page).toHaveURL(/\/profile\/sessions$/)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Устройства и сессии', exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('sessions-loading')).toHaveCount(0)
}

/** What the other device meets once its session has been ended: its next call is refused, and it is signed out. */
async function expectSignedOut(device: Page): Promise<void> {
  // The access token is still good for minutes: the next thing the person does is what finds out.
  await talkButton(device).click()
  await expect(device).toHaveURL(/\/login$/, { timeout: 30_000 })
}

test('устройства и сессии: список, завершение чужой, остальные, выход везде', async ({
  page,
  newDevice,
  shot,
}) => {
  test.setTimeout(240_000)
  const violations = await watchCsp(page)
  const email = uniqueEmail('web-sessions')
  await clearMailbox()

  // ── two devices of one account ───────────────────────────────────────────
  await openWebApp(page)
  await registerAndConfirm(page, email)
  const other = await newDevice()
  await presentAs(other, FIREFOX_ON_LINUX)
  await signInOn(other, email)

  // ── the list: this one marked, the other named by what it said about itself ─
  await openSessions(page)
  const current = page.getByTestId('sessions-current').getByTestId('session-row')
  await expect(current).toHaveCount(1)
  await expect(current).toContainText('Это устройство')
  await expect(
    current.getByTestId('session-end'),
    'свою сессию отсюда не завершить: для этого «Выйти»',
  ).toHaveCount(0)
  const others = page.getByTestId('sessions-others').getByTestId('session-row')
  await expect(others).toHaveCount(1)
  await expect(others.getByTestId('session-title')).toHaveText('Firefox · Linux')
  await expect(others).toContainText('Была активна сегодня')
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-sessions')

  // ── ending the other device ──────────────────────────────────────────────
  await others.getByTestId('session-end').click()
  await expect(page.getByTestId('sessions-none')).toHaveText('Других устройств нет.')
  await expect(page.getByTestId('end-others')).toHaveCount(0)
  await expectSignedOut(other)

  // ── ending all the others at once ────────────────────────────────────────
  await signInOn(other, email)
  const third = await newDevice()
  await presentAs(third, FIREFOX_ON_LINUX)
  await signInOn(third, email)
  await page.reload()
  await expect(page.getByTestId('sessions-others').getByTestId('session-row')).toHaveCount(2)
  await page.getByTestId('end-others').click()
  await expect(modal(page).getByRole('heading', { name: 'Завершить остальные сессии' })).toBeVisible()
  await shot(page, 'web-sessions-end-others')
  await page.getByTestId('end-others-confirm').click()
  await expect(page.getByTestId('sessions-none')).toBeVisible()
  await expect(modal(page)).toHaveCount(0)
  // This device stays: it is still in, and the list still knows it.
  await expect(page.getByTestId('sessions-current')).toContainText('Это устройство')
  await expectSignedOut(other)
  await expectSignedOut(third)

  // ── a dialog that is open on another device closes when its session ends ──
  await signInOn(other, email)
  await talkButton(other).click()
  await expect(other).toHaveURL(/\/dialog\//, { timeout: 30_000 })
  await page.reload()
  await page.getByTestId('sessions-others').getByTestId('session-end').click()
  await expect(page.getByTestId('sessions-none')).toBeVisible()
  // The gateway asks the registry every couple of seconds (the stack sets it so), and the client then
  // finds that its session is gone.
  await expect(other).toHaveURL(/\/login$/, { timeout: 30_000 })

  // ── signing out everywhere takes this device too ─────────────────────────
  await signInOn(other, email)
  await page.getByTestId('end-all').click()
  await expect(modal(page).getByRole('heading', { name: 'Выйти на всех устройствах' })).toBeVisible()
  await shot(page, 'web-sessions-end-all')
  await modalButton(page, 'Отмена').click()
  await expect(modal(page)).toHaveCount(0)
  // Cancelling changes nothing.
  await page.reload()
  await expect(page.getByTestId('sessions-others').getByTestId('session-row')).toHaveCount(1)

  await page.getByTestId('end-all').click()
  await page.getByTestId('end-all-confirm').click()
  await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 })
  await expect(button(page, 'Войти')).toBeVisible()
  await expectSignedOut(other)

  // And the account is not lost: the same address and password open it again.
  await signIn(page, email)
  expect(await violations(), 'политика безопасности не нарушена ни на одном экране').toEqual([])
})
