import {
  endConversation,
  homeInput,
  messages,
  openWebApp,
  registerAndConfirm,
  uniqueEmail,
  webUrl,
} from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

/**
 * A link to one conversation (`REQ-DATA-05`, `openspec/changes/add-dialog-share-link`): made from the
 * journal entry, opened by someone who is not signed in, shown again, revoked. One scenario for the
 * same reason as the other web specs (one sign-up).
 */
const FIRST_MESSAGE = 'Сегодня было очень тяжело'

test('ссылка на разговор: создать, открыть чужим, увидеть снова, отозвать', async ({ page, browser, shot }) => {
  test.setTimeout(180_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-share'))

  await homeInput(page).fill(FIRST_MESSAGE)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'assistant')).toHaveCount(2, { timeout: 30_000 })
  await endConversation(page, 'Про тяжёлый день')

  // The finished conversation, read-only in the journal, carries the button.
  await openWebApp(page, '/journal')
  await page.getByTestId('journal-item').first().click()
  await expect(page).toHaveURL(/\/journal\/[^/]+$/)
  await page.getByTestId('journal-share').click()

  // ── no link yet: the term (24 hours by default) and the warning ──────────
  await expect(page.getByTestId('share-warning')).toContainText('весь текст')
  await expect(page.getByTestId('share-ttl-24')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('share-ttl-72').click()
  await shot(page, 'web-share-create')
  await page.getByTestId('share-create').click()
  await expect(page.getByTestId('share-active')).toBeVisible()
  const url = await page.getByTestId('share-url').inputValue()
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/)
  await shot(page, 'web-share-active')

  // ── someone else opens it: a clean browser, no session ───────────────────
  const stranger = await browser.newContext()
  const guest = await stranger.newPage()
  const response = await guest.goto(url)
  expect(response?.headers()['referrer-policy']).toBe('no-referrer')
  expect(response?.headers()['x-robots-tag']).toContain('noindex')
  await expect(guest.getByTestId('shared-banner')).toBeVisible({ timeout: 30_000 })
  await expect(guest.getByTestId('shared-messages').getByTestId('dialog-message')).toHaveCount(2)
  await expect(guest.getByText(FIRST_MESSAGE)).toBeVisible()
  // Read-only: no input, and nothing of the summary.
  await expect(guest.locator('textarea, input')).toHaveCount(0)
  await expect(guest.getByText('Напряжение')).toHaveCount(0)
  await shot(guest, 'web-share-recipient')

  // ── the owner sees it again after a reload, with the view counted ────────
  await page.reload()
  await page.getByTestId('journal-share').click()
  await expect(page.getByTestId('share-url')).toHaveValue(url)
  await expect(page.getByTestId('share-meta')).toContainText('1 просмотр')

  // ── revoke: the same address now says it is gone ─────────────────────────
  await page.getByTestId('share-revoke').click()
  await page.getByTestId('share-revoke-confirm').click()
  await expect(page.getByTestId('share-create')).toBeVisible()
  await guest.reload()
  await expect(guest.getByTestId('shared-gone')).toBeVisible({ timeout: 30_000 })
  await shot(guest, 'web-share-gone')
  await stranger.close()

  // An address that never existed looks the same.
  const never = await browser.newContext()
  const nobody = await never.newPage()
  await nobody.goto(webUrl('/s/' + 'x'.repeat(43)))
  await expect(nobody.getByTestId('shared-gone')).toBeVisible({ timeout: 30_000 })
  await never.close()
})
