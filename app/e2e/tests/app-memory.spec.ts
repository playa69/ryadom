import { button, openApp, openTab, sheetButton, startAnonymously } from '../support/app'
import { expect, test } from '../support/fixtures'

/**
 * Memory in the app (PWA), the counterpart of web-memory.spec.ts: turn it on through the consent
 * sheet, talk and ask "запомни, что …", see the card "Я запомнил" on home, take the point off it,
 * and find the screen "Память" empty again. The agent is the mock (see the web scenario).
 */

const FACT = 'Мне помогают вечерние прогулки'

test('память в приложении: включить → разговор → карточка → убрать', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await openApp(page)
  await startAnonymously(page)
  await expect(page.getByTestId('incognito')).toHaveCount(0)

  // ── Profile → Память: off, then on through the consent sheet ───────────────────────────────
  await openTab(page, 'Профиль')
  await page.locator('.page-current').getByTestId('row-memory').click()
  const memory = page.locator('.page-current[data-name="memory"]')
  await expect(memory).toBeVisible()
  await expect(memory.getByTestId('memory-empty')).toContainText('Если включить память')

  await memory.getByTestId('memory-switch').locator('.toggle').click()
  const consent = page.locator('.sheet-modal.modal-in')
  await expect(consent.getByTestId('memory-consent')).toBeVisible()
  await expect(consent).toContainText('Память можно не включать')
  await shot(page, 'memory-consent')
  await sheetButton(page, 'Включить память').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  await expect(memory.getByTestId('memory-switch').locator('input[type="checkbox"]')).toBeChecked()
  await expect(memory.getByTestId('memory-empty')).toContainText('Пока я ничего не запомнил')
  await shot(page, 'memory-empty')

  // ── a conversation: the person asks to remember, then ends it ──────────────────────────────
  await openTab(page, 'Главная')
  await expect(page.getByTestId('incognito')).toBeVisible()
  await shot(page, 'memory-home-incognito')
  await button(page, 'Поговорить').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder('Напиши, что происходит')
  await expect(input).toBeVisible()
  await input.fill(`Запомни, что ${FACT.charAt(0).toLowerCase()}${FACT.slice(1)}`)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.locator('.message-sent')).toHaveCount(2, { timeout: 20_000 })
  await expect(page.locator('.message-received')).toHaveCount(3, { timeout: 30_000 })

  await page.locator('.page-current').getByRole('button', { name: 'Завершить разговор' }).click()
  await sheetButton(page, 'Завершить').click()
  const done = page.locator('.dialog.modal-in')
  await expect(done).toBeVisible({ timeout: 30_000 })
  await done.getByText('ОК').click()

  // ── the card on home ───────────────────────────────────────────────────────────────────────
  const card = page.locator('.page-current').getByTestId('memory-card')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText('Я запомнил')
  await expect(card.getByTestId('memory-card-item')).toContainText(FACT)
  await shot(page, 'memory-card')

  // "убрать" can be taken back for five seconds, then the point goes and with it the card.
  await card.getByTestId('memory-card-dismiss').click()
  await expect(card.getByTestId('memory-undo')).toBeVisible()
  await card.getByTestId('memory-undo-button').click()
  await expect(card.getByTestId('memory-card-item')).toContainText(FACT)
  await card.getByTestId('memory-card-dismiss').click()
  await expect(page.getByTestId('memory-card')).toHaveCount(0, { timeout: 15_000 })

  // ── and the screen "Память" holds nothing again ────────────────────────────────────────────
  await openTab(page, 'Профиль')
  await expect(memory.getByTestId('memory-empty')).toBeVisible({ timeout: 20_000 })
})
