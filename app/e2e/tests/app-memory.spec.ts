import type { Page } from '@playwright/test'
import { button, openApp, openTab, sheetButton, startAnonymously } from '../support/app'
import { expect, test } from '../support/fixtures'

/**
 * Memory in the app (PWA), the counterpart of web-memory.spec.ts (REQ-MEM-*, change add-memory-notes):
 * turn it on through the consent sheet, say a few things about yourself, see them as notes in the sheet
 * "Что помнит Рядом", correct one, delete one with "Вернуть", tell Ryadom what to correct, switch on
 * "Запоминать чувствительное", pause memory and delete all of it. The agent is the mock
 * (app/dev/agent-mock/memory-notes.mjs): ~1.5 s after a line of the person it turns it into notes.
 */

const SAID = 'Меня зовут Алекс, я работаю в продажах'
const NAME_NOTE = 'Зовут Алекс'
const WORK_NOTE = 'Работает в продажах'

test('память в приложении: согласие → разговор → заметки → правка → «Вернуть» → «Скажи, что поправить» → пауза → удалить всё', async ({
  page,
  shot,
}) => {
  test.setTimeout(240_000)
  await openApp(page)
  await startAnonymously(page)

  // ── Profile → Память: off, the two lower switches wait; on through the consent sheet ───────
  await openTab(page, 'Профиль')
  await page.locator('.page-current').getByTestId('row-memory').click()
  const memory = page.locator('.page-current[data-name="memory"]')
  await expect(memory).toBeVisible()
  const memorySwitch = memory.getByTestId('memory-switch')
  const sensitiveSwitch = memory.getByTestId('memory-sensitive-switch')
  const searchSwitch = memory.getByTestId('memory-chat-search-switch')
  await expect(memorySwitch.locator('input[type="checkbox"]')).not.toBeChecked()
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeDisabled()
  await expect(searchSwitch.locator('input[type="checkbox"]')).toBeDisabled()
  await shot(page, 'memory-off')

  await memorySwitch.locator('.toggle').click()
  const consent = page.locator('.sheet-modal.modal-in')
  await expect(consent.getByTestId('memory-consent')).toBeVisible()
  await expect(consent).toContainText('Память можно не включать')
  await shot(page, 'memory-consent')
  await sheetButton(page, 'Включить память').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  await expect(memorySwitch.locator('input[type="checkbox"]')).toBeChecked()
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeEnabled()
  await expect(memory).toContainText('Опираться на прошлые разговоры')
  await shot(page, 'memory-on')

  // The sheet is empty to begin with.
  await memory.getByTestId('memory-open-notes').click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByTestId('memory-empty')).toContainText('Пока пусто — заметки появятся по мере разговоров')
  await shot(page, 'memory-sheet-empty')
  await sheetButton(page, 'Закрыть').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  // ── a conversation: the person tells about themselves ──────────────────────────────────────
  await openTab(page, 'Главная')
  await button(page, 'Поговорить').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder('Напиши, что происходит')
  await expect(input).toBeVisible()
  await input.fill(SAID)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.locator('.message-sent')).toHaveCount(2, { timeout: 20_000 })
  await expect(page.locator('.message-received')).toHaveCount(3, { timeout: 30_000 })

  // ── the sheet from the conversation's bar: the notes in groups, with dates ────────────────
  // The mock extracts the notes ~1.5 s after the line; the sheet reads them when it opens.
  await page.waitForTimeout(3000)
  await page.locator('.page-current').getByTestId('memory-nav').click()
  await expect(sheet.getByTestId('memory-notes')).toBeVisible()
  await expect(sheet.getByTestId('memory-note').filter({ hasText: NAME_NOTE })).toBeVisible({ timeout: 20_000 })
  await expect(sheet.getByTestId('memory-note').filter({ hasText: WORK_NOTE })).toBeVisible()
  await expect(sheet.locator('[data-group="about"]')).toContainText('Обо мне и как со мной говорить')
  await expect(sheet.locator('[data-group="work"]')).toContainText('Работа и дела')
  await shot(page, 'memory-sheet-notes')
  await sheetButton(page, 'Закрыть').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  await page.locator('.page-current').getByRole('button', { name: 'Завершить разговор' }).click()
  await sheetButton(page, 'Завершить').click()
  const done = page.locator('.dialog.modal-in')
  await expect(done).toBeVisible({ timeout: 30_000 })
  await done.getByText('ОК').click()

  // ── the card "Я запомнил" is gone from home ─────────────────────────────────────────────────
  await expect(page.getByTestId('memory-card')).toHaveCount(0)

  // ── Profile → Память → the sheet: correct a note ─────────────────────────────────────────────
  await openTab(page, 'Профиль')
  await expect(memory.getByTestId('memory-open-notes')).toBeVisible({ timeout: 20_000 })
  await memory.getByTestId('memory-open-notes').click()
  const nameNote = sheet.getByTestId('memory-note').filter({ hasText: NAME_NOTE })
  await expect(nameNote).toBeVisible({ timeout: 20_000 })
  await nameNote.getByTestId('memory-note-open').click()
  const edit = sheet.getByTestId('memory-note-edit')
  await expect(edit).toBeVisible()
  await edit.locator('textarea').fill('Зовут Александр')
  await shot(page, 'memory-note-edit')
  await sheetButton(page, 'Сохранить').click()
  await expect(sheet.getByTestId('memory-note').filter({ hasText: 'Зовут Александр' })).toBeVisible({ timeout: 15_000 })
  await shot(page, 'memory-note-edited')

  // A rule refuses a text the agent must never keep.
  await sheet.getByTestId('memory-note').filter({ hasText: 'Зовут Александр' }).getByTestId('memory-note-open').click()
  await edit.locator('textarea').fill('Принимает антидепрессанты')
  await sheetButton(page, 'Сохранить').click()
  await expect(edit.getByTestId('form-error')).toContainText('Так запомнить не получится')
  await shot(page, 'memory-note-refused')
  await sheetButton(page, 'Отмена').click()

  // ── "×": gone at once, can be taken back for five seconds, then really deleted ───────────────
  const workNote = sheet.getByTestId('memory-note').filter({ hasText: WORK_NOTE })
  await workNote.getByTestId('memory-note-remove').click()
  await expect(sheet.getByTestId('memory-undo')).toBeVisible()
  await shot(page, 'memory-note-undo')
  await sheet.getByTestId('memory-undo-button').click()
  await expect(workNote).toBeVisible()
  await workNote.getByTestId('memory-note-remove').click()
  await expect(sheet.getByTestId('memory-note').filter({ hasText: WORK_NOTE })).toHaveCount(0, { timeout: 15_000 })
  await expect(sheet.getByTestId('memory-undo')).toHaveCount(0, { timeout: 15_000 })

  // ── "Скажи, что поправить или убрать" ─────────────────────────────────────────────────────────
  await sheet.getByTestId('memory-instruction').locator('input').fill('Не Александр, а Саша')
  await sheet.getByTestId('memory-instruction-send').click()
  await expect(sheet.getByTestId('memory-instruction-result')).toContainText('Изменено: 1', { timeout: 15_000 })
  await expect(sheet.getByTestId('memory-note').filter({ hasText: 'Зовут Саша' })).toBeVisible()
  await shot(page, 'memory-instruction')
  await sheetButton(page, 'Закрыть').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  // ── "Запоминать чувствительное" ───────────────────────────────────────────────────────────────
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).not.toBeChecked()
  await sensitiveSwitch.locator('.toggle').click()
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeChecked()
  await expect(searchSwitch.locator('input[type="checkbox"]')).toBeChecked()
  await shot(page, 'memory-sensitive-on')

  // ── pause: the notes stay, the two lower switches wait ───────────────────────────────────────
  await memorySwitch.locator('.toggle').click()
  await expect(memorySwitch.locator('input[type="checkbox"]')).not.toBeChecked()
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeDisabled()
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeChecked()
  await memory.getByTestId('memory-open-notes').click()
  await expect(sheet.getByTestId('memory-paused')).toContainText('Память на паузе — Рядом не использует эти заметки')
  await expect(sheet.getByTestId('memory-note').filter({ hasText: 'Зовут Саша' })).toBeVisible()
  await shot(page, 'memory-paused')
  await sheetButton(page, 'Закрыть').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  // ── "Удалить всю память": the notes go, the switches and the consent stay ────────────────────
  await memory.getByTestId('memory-forget-all').click()
  const confirm = page.locator('.dialog.modal-in')
  await expect(confirm).toContainText('Рядом забудет всё, что успел узнать о тебе')
  await shot(page, 'memory-forget-all-confirm')
  await confirm.getByText('ОК').click()
  await expect(page.locator('.dialog.modal-in')).toHaveCount(0)
  await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeChecked()
  await expect(memorySwitch.locator('input[type="checkbox"]')).not.toBeChecked()
  await memory.getByTestId('memory-open-notes').click()
  await expect(sheet.getByTestId('memory-empty')).toBeVisible()
  await expect(sheet.getByTestId('memory-note')).toHaveCount(0)
  await shot(page, 'memory-deleted')
})

// ── the invitation to memory on home (REQ-MEM-*, task 6.7) ─────────────────────────────────────────

test('приглашение к памяти: аноним видит лист; «Не сейчас» не возвращается; «Включить» → согласие → память включена', async ({
  page,
  shot,
}) => {
  test.setTimeout(120_000)
  await openApp(page, { keepMemoryInvite: true })
  await startAnonymously(page)

  const invite = page.locator('.sheet-modal.modal-in').getByTestId('memory-invite')
  await expect(invite).toBeVisible({ timeout: 20_000 })
  await expect(invite).toContainText('Рядом теперь запоминает важное')
  await shot(page, 'memory-invite')

  // "Не сейчас": closes, and does not come back after a reload.
  await sheetButton(page, 'Не сейчас').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  await expect(page.getByTestId('memory-invite')).toBeHidden()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  // A second person on a fresh device: "Включить" leads to the consent sheet, then memory is on.
  await page.evaluate((key) => window.localStorage.removeItem(key), 'ryadom.memory-invite-dismissed')
  await page.reload()
  await expect(invite).toBeVisible({ timeout: 20_000 })
  await sheetButton(page, 'Включить').first().click()
  const consent = page.locator('.sheet-modal.modal-in')
  await expect(consent.getByTestId('memory-consent')).toBeVisible({ timeout: 10_000 })
  await sheetButton(page, 'Включить память').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  await openTab(page, 'Профиль')
  await page.locator('.page-current').getByTestId('row-memory').click()
  const memory = page.locator('.page-current[data-name="memory"]')
  await expect(memory.getByTestId('memory-switch').locator('input[type="checkbox"]')).toBeChecked()

  // Memory on: the invitation is not shown any more, even when the answer was forgotten.
  await page.evaluate((key) => window.localStorage.removeItem(key), 'ryadom.memory-invite-dismissed')
  await page.reload()
  await expect(page.locator('.page-current')).toBeVisible()
  await page.waitForTimeout(2500)
  await expect(page.getByTestId('memory-invite')).toBeHidden()
})

// ── "Запомнил: … · Убрать" in the conversation (task 6.4) ──────────────────────────────────────────

const SLEEP_SAID = 'Последние недели плохо сплю'
const SLEEP_NOTE = 'Последние недели плохо спит'

async function turnMemoryOn(page: Page, sensitive: boolean): Promise<void> {
  await openTab(page, 'Профиль')
  await page.locator('.page-current').getByTestId('row-memory').click()
  const memory = page.locator('.page-current[data-name="memory"]')
  await expect(memory).toBeVisible()
  await memory.getByTestId('memory-switch').locator('.toggle').click()
  await sheetButton(page, 'Включить память').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  const sensitiveSwitch = memory.getByTestId('memory-sensitive-switch')
  if (sensitive) {
    await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeEnabled()
    await sensitiveSwitch.locator('.toggle').click()
    await expect(sensitiveSwitch.locator('input[type="checkbox"]')).toBeChecked()
  }
  await openTab(page, 'Главная')
}

async function say(page: Page, text: string): Promise<void> {
  await button(page, 'Поговорить').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder('Напиши, что происходит')
  await expect(input).toBeVisible()
  await input.fill(text)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.locator('.message-sent')).toHaveCount(2, { timeout: 20_000 })
}

test('«Запомнил: … · Убрать»: новая чувствительная заметка → строка по опросу → «Убрать» удаляет', async ({
  page,
  shot,
}) => {
  test.setTimeout(180_000)
  await openApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page, true)
  await say(page, SLEEP_SAID)

  const notice = page.getByTestId('memory-notice')
  await expect(notice).toContainText(`Запомнил: ${SLEEP_NOTE}`, { timeout: 30_000 })
  await expect(notice).toContainText('Убрать')
  await shot(page, 'memory-notice')
  await page.getByTestId('memory-notice-remove').click()
  await expect(notice).toHaveCount(0)
  await shot(page, 'memory-notice-removed')

  // Deleted for real: the sheet has no such note.
  const sheet = page.locator('.sheet-modal.modal-in')
  await page.locator('.page-current').getByTestId('memory-nav').click()
  await expect(sheet.getByTestId('memory-notes').or(sheet.getByTestId('memory-empty'))).toBeVisible()
  await expect(sheet.getByTestId('memory-note').filter({ hasText: SLEEP_NOTE })).toHaveCount(0)
})

test('«Запомнил: …»: без «Запоминать чувствительное» строки нет', async ({ page }) => {
  test.setTimeout(120_000)
  await openApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page, false)
  await say(page, SLEEP_SAID)
  // Longer than the poll interval and the mock's delay.
  await page.waitForTimeout(14_000)
  await expect(page.getByTestId('memory-notice')).toHaveCount(0)
})
