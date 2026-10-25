import { expect, type Page } from '@playwright/test'
import { PWA_URL } from '../playwright.config'
import { waitForCode } from './mail'

/**
 * Steps that repeat across scenarios.
 *
 * Selectors go by field name and visible text: Framework7 does not tie labels to inputs
 * (getByLabel does not work) and renders its own buttons as `a`, so the role of one and the same
 * button depends on whether it is ours or the framework's.
 */

export const PASSWORD = 'e2e-Password-1'

/** A unique email per run: the database is not cleaned between tests. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`
}

/**
 * The screen that is currently visible. Framework7 keeps previous pages in the DOM, so a search
 * over the whole document finds fields from several screens at once.
 */
function screen(page: Page) {
  return page.locator('.page-current')
}

export function field(page: Page, name: string) {
  return screen(page).locator(`input[name="${name}"]`)
}

/** A button whether it is a `button` or a Framework7 `a`. */
export function button(page: Page, name: string | RegExp) {
  const scope = screen(page)
  return scope.getByRole('button', { name }).or(scope.getByRole('link', { name })).first()
}

/**
 * The consent checkbox. Framework7 hides the `input` itself and draws an icon, so `check()` on
 * the field does nothing; the icon is what has to be clicked.
 */
export async function checkConsent(page: Page): Promise<void> {
  const consent = screen(page).getByTestId('consents')
  const icons = consent.locator('.icon-checkbox')
  // The page may still be sliding in: count only once the first box is on screen.
  await expect(icons.first()).toBeVisible()
  const count = await icons.count()
  expect(count, 'в блоке согласий есть что отметить').toBeGreaterThan(0)
  for (let index = 0; index < count; index += 1) {
    await icons.nth(index).click()
    await expect(consent.locator('input[type="checkbox"]').nth(index)).toBeChecked()
  }
}

/** Closes the open sheet with the sheet's own button. */
export async function closeSheet(page: Page): Promise<void> {
  await sheetButton(page, 'Закрыть').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
}

/** A button inside the open sheet: it lives outside the page. */
export function sheetButton(page: Page, name: string | RegExp) {
  const scope = page.locator('.sheet-modal.modal-in')
  return scope.getByRole('button', { name }).or(scope.getByRole('link', { name })).first()
}

export async function openApp(page: Page): Promise<void> {
  await page.goto(`${PWA_URL}/`)
  // A new visitor lands on the first screen, someone with a session on home.
  await expect(button(page, 'Начать').or(button(page, 'Поговорить'))).toBeVisible({ timeout: 30_000 })
  // The PWA install banner covers the bottom of the screen and is not needed in the test browser.
  const dismiss = page.getByRole('button', { name: 'Скрыть' })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

/**
 * The first screen as a new visitor meets it: all three agreements, then "Начать". An account is made
 * behind the scenes and the person is on the home screen, with no address and no password.
 */
export async function startAnonymously(page: Page): Promise<void> {
  await checkConsent(page)
  await button(page, 'Начать').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(password)
  await button(page, 'Войти').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 20_000 })
}

/** Sign-up with email confirmation: afterwards the person is already inside. */
export async function registerAndConfirm(page: Page, email: string, name = 'Тест'): Promise<void> {
  // A new visitor meets the first screen and opens the sign-in from it; from the sign-in screen the
  // sign-up is one button away.
  const haveAccount = screen(page).getByTestId('have-account')
  if (await haveAccount.isVisible().catch(() => false)) await haveAccount.click()
  await button(page, 'Создать аккаунт').click()
  await expect(page.getByText('Давай знакомиться')).toBeVisible()

  await field(page, 'name').fill(name)
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(PASSWORD)
  // Consent to data processing is mandatory: without it the account is not created.
  await checkConsent(page)
  await button(page, 'Создать аккаунт').click()

  await expect(page.getByText('Подтверди почту')).toBeVisible({ timeout: 20_000 })
  const code = await waitForCode(email)
  // Six digits submit on their own, no button needed.
  await page.getByRole('textbox', { name: 'Код из письма' }).fill(code)

  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
}

export async function openTab(page: Page, label: 'Главная' | 'Дневник' | 'Профиль'): Promise<void> {
  await page.locator('#rd-tabbar').getByText(label, { exact: true }).click()
}

/** The journal lives inside the diary: the tab «Дневник», then its segment «Журнал». */
export async function openJournal(page: Page): Promise<void> {
  await openTab(page, 'Дневник')
  await page.getByTestId('diary-segment-journal').click()
}
