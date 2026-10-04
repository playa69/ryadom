import { expect, type Locator, type Page } from '@playwright/test'
import { WEBAPP_URL } from '../playwright.config'
import { PASSWORD } from './app'
import { waitForCode } from './mail'

/**
 * Steps that repeat across the scenarios of the web app (apps/web), the counterpart of app.ts for
 * the Framework7 client.
 *
 * Unlike that client, this one is plain HTML: labels are tied to their inputs, buttons are real
 * buttons and the confirmation modals are real dialogs, so selectors go by role and visible text,
 * with field names where a label would be ambiguous.
 *
 * The frame is a classic app layout: a sidebar on the left (new conversation, history, account) and
 * the page beside it. Below 768px the sidebar is a drawer that the menu button opens, so the
 * navigation helpers open it first when it is not on screen.
 */

// The same account helpers as the Framework7 client's scenarios use.
export { PASSWORD, uniqueEmail } from './app'

export function webUrl(path = '/'): string {
  return `${WEBAPP_URL}${path}`
}

/**
 * Opens a page and waits for the network to settle. The forms are plain `method="post"` until the
 * page hydrates, so a click made too early would submit them for real instead of running the
 * handler.
 */
export async function openWebApp(page: Page, path = '/'): Promise<void> {
  await page.goto(webUrl(path), { waitUntil: 'networkidle' })
}

export function field(page: Page, name: string): Locator {
  return page.locator(`input[name="${name}"]`)
}

/** Exact for plain text: «Войти» must not also match «Не получается войти?». */
export function button(page: Page, name: string | RegExp): Locator {
  return page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name })
}

/**
 * The open modal. A closed one is not in the page, so a count of zero means nothing is open. The
 * phone's drawer is a dialog too: close it before looking for a modal.
 */
export function modal(page: Page): Locator {
  return page.getByRole('dialog')
}

export function modalButton(page: Page, name: string): Locator {
  return modal(page).getByRole('button', { name, exact: true })
}

/** The consent checkbox: a real input inside the `consents` label (sign-up and account deletion). */
export async function checkConsent(page: Page): Promise<void> {
  const box = page.getByTestId('consents').getByRole('checkbox')
  await box.check()
  await expect(box).toBeChecked()
}

/** What a layout decision hangs on: the sidebar is a drawer below 768px and a column from there up. */
export function viewportWidth(page: Page): number {
  return page.viewportSize()?.width ?? 0
}

/** shadcn's `md`: the width at which the sidebar stops being a drawer. */
export const SIDEBAR_BREAKPOINT = 768

export function isPhone(page: Page): boolean {
  return viewportWidth(page) < SIDEBAR_BREAKPOINT
}

/**
 * The sidebar's links: brand, "Новый разговор", "Люди рядом", the history and "Все разговоры". Always
 * the same `nav`, but below 768px it only exists while the drawer is open (see `openSidebar`).
 */
export function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Основное' })
}

/** The menu button in the page header: opens the drawer on a phone, folds the column on a desktop. */
export function menuButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Меню', exact: true })
}

/** The phone's drawer. A modal sheet, so it is the one open dialog while it is there. */
export function drawer(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Меню', exact: true })
}

/** Makes the sidebar's links reachable: a no-op on a desktop, the menu button on a phone. */
export async function openSidebar(page: Page): Promise<void> {
  if (!(await nav(page).isVisible())) await menuButton(page).click()
  await expect(nav(page)).toBeVisible()
}

/** Puts the drawer away again (a phone only); a desktop keeps its column. */
export async function closeSidebar(page: Page): Promise<void> {
  if (!isPhone(page)) return
  if (await drawer(page).isVisible()) await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
}

export type SidebarTarget = 'Новый разговор' | 'Люди рядом' | 'Все разговоры'

/** Follows a link of the sidebar, as a person does; a drawer on a phone has closed again afterwards. */
export async function goTo(page: Page, target: SidebarTarget): Promise<void> {
  await openSidebar(page)
  await nav(page).getByRole('link', { name: target, exact: true }).click()
  if (isPhone(page)) await expect(drawer(page)).toHaveCount(0)
}

/** The account button at the foot of the sidebar, with the menu it opens (profile, sign out). */
export function accountMenu(page: Page): Locator {
  return page.getByTestId('account-menu')
}

export async function openAccountMenu(page: Page): Promise<void> {
  await openSidebar(page)
  await accountMenu(page).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

export function menuItem(page: Page, name: string): Locator {
  return page.getByRole('menuitem', { name, exact: true })
}

/** The profile is not a tab any more: it opens from the account menu. */
export async function openProfile(page: Page): Promise<void> {
  await openAccountMenu(page)
  await menuItem(page, 'Профиль').click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Профиль', exact: true })).toBeVisible()
  if (isPhone(page)) await expect(drawer(page)).toHaveCount(0)
}

/** The conversations in the sidebar, newest first. */
export function historyItems(page: Page): Locator {
  return nav(page).getByTestId('history-item')
}

/** The blue dot on a conversation that has not been ended. */
export function openMark(page: Page): Locator {
  return nav(page).getByRole('img', { name: 'Разговор не завершён' })
}

/**
 * Checks how many conversations the sidebar lists. A phone has to open the drawer to see them, and
 * the drawer is put away again so the next step meets the page itself.
 */
export async function expectHistoryCount(page: Page, count: number): Promise<void> {
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(count)
  await closeSidebar(page)
}

/** One SOS button, in the page header. */
export function sosButton(page: Page): Locator {
  return page.getByRole('button', { name: 'SOS', exact: true })
}

/**
 * Every header carries one SOS button and nothing else renders another. Role queries skip hidden
 * elements, so a count of exactly one means exactly one is on screen at this width.
 */
export async function expectSingleSos(page: Page): Promise<void> {
  await expect(sosButton(page)).toHaveCount(1)
  await expect(sosButton(page)).toBeVisible()
}

/** The h1 of the page: the header holds it, and a screen has exactly one. */
export function pageTitle(page: Page): Locator {
  return page.getByRole('heading', { level: 1 })
}

/** The big box in the middle of the home page. */
export function homeInput(page: Page): Locator {
  return page.getByTestId('home-input')
}

/** The box under a conversation. */
export function dialogInput(page: Page): Locator {
  return page.getByTestId('dialog-input')
}

/** With nothing typed the home page's send button reads "Поговорить" and starts a conversation without words. */
export function talkButton(page: Page): Locator {
  return button(page, 'Поговорить')
}

/** The lines of the feed under the header, by who said them. */
export function messages(page: Page, role: 'user' | 'assistant'): Locator {
  return page.locator(`[data-testid="dialog-message"][data-role="${role}"]`)
}

/**
 * Ends the conversation that is open the way a person does: the button in the header, a takeaway,
 * the closing sheet, and out through the summary to home.
 */
export async function endConversation(page: Page, takeaway: string): Promise<void> {
  // Ending in the middle of a reply would only test the fallback timer.
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await page.getByTestId('dialog-end').click()
  await expect(modal(page).getByRole('heading', { name: 'Что забираешь с собой?' })).toBeVisible()
  await page.getByTestId('takeaway-input').fill(takeaway)
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(password)
  await button(page, 'Войти').click()
  await expect(talkButton(page)).toBeVisible({ timeout: 20_000 })
}

/** Sign-up with email confirmation: afterwards the person is already inside, on the home screen. */
export async function registerAndConfirm(page: Page, email: string, name = 'Тест'): Promise<void> {
  await page.getByRole('link', { name: 'Создать аккаунт', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Давай знакомиться' })).toBeVisible()

  await field(page, 'name').fill(name)
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(PASSWORD)
  // Consent to data processing is mandatory: without it the account is not created.
  await checkConsent(page)
  await button(page, 'Создать аккаунт').click()

  await expect(page.getByRole('heading', { name: 'Подтверди почту' })).toBeVisible({ timeout: 20_000 })
  const code = await waitForCode(email)
  // Six digits submit on their own, no button needed; the screen then signs in with the password.
  await page.getByRole('textbox', { name: 'Код из письма' }).fill(code)

  await expect(talkButton(page)).toBeVisible({ timeout: 30_000 })
}

/** The page must not scroll sideways at any width: that is the first thing a narrow screen breaks. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
      document.documentElement.clientWidth,
  )
  expect(overflow, 'страница шире окна').toBeLessThanOrEqual(0)
}

interface CspWindow {
  __cspViolations?: string[]
}

/**
 * Starts collecting the policy violations the browser reports. Call it before the first
 * navigation; the returned function lists what has been collected on the current document, which
 * for a single-page flow is everything since the page was opened.
 */
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const store = window as unknown as CspWindow
    store.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })
  return () => page.evaluate(() => (window as unknown as CspWindow).__cspViolations ?? [])
}
