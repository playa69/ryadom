import type { Page } from '@playwright/test'
import { button, openApp, openTab, sheetButton, startAnonymously } from '../support/app'
import { step } from '../support/evidence'
import { expectInsideViewport } from '../support/layout'
import { expect, test } from '../support/fixtures'

/**
 * Memory in the app (PWA), the counterpart of web-memory.spec.ts (REQ-MEM-*, change add-memory-notes):
 * turn it on through the consent sheet, say a few things about yourself, see them as notes in the sheet
 * "Что помнит Рядом", correct one, delete one with "Вернуть", tell Ryadom what to correct, switch on
 * "Запоминать чувствительное", pause memory and delete all of it. The agent is the mock
 * (app/dev/agent-mock/memory-notes.mjs): ~1.5 s after a line of the person it turns it into notes, and it answers
 * `GET /memory/changes` like the real agent (the block "Я запомнил" of the closing window: `pending` until the final pass after
 * the end is done, then the notes of that conversation).
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
  await expect(sheet.getByTestId('memory-notes').or(sheet.getByTestId('memory-empty')).first()).toBeVisible()
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

// ── the block "Я запомнил" in the window after a conversation (PROTEUS-242, D16) ─────────────────

const RECAP_ONE = 'Люблю море'
const RECAP_ONE_NOTE = 'Любит море'
// One message, six notes: the mock takes every phrase pattern in a line.
const RECAP_MANY =
  'Меня зовут Борис, я работаю в школе, у меня есть сестра Маша, люблю горы, не хочу говорить про отца, запомни, что у меня кот Барсик'

const closing = (page: Page) => page.locator('.dialog.modal-in')
const recap = (page: Page) => closing(page).getByTestId('memory-recap')
const recapList = (page: Page) => recap(page).getByTestId('memory-recap-list')
const recapNotes = (page: Page) => recap(page).getByTestId('memory-recap-note')
const recapNote = (page: Page, text: string) => recapNotes(page).filter({ hasText: text })
const recapLate = (page: Page) => closing(page).getByTestId('memory-recap-late')
// The words under the text of the window when the final pass is still going after the 30 seconds the app waits.
const STILL_WRITING = 'Ещё записываю, что запомнить. Загляни в «Что помнит Рядом» чуть позже.'

/** The notes of the six-note conversation, in the order they were said (the mock's wording). */
const MANY_NOTES = [
  'Зовут Борис',
  'Работает в школе',
  'Есть сестра Маша',
  'Любит горы',
  'Не хочет обсуждать отца',
  'У меня кот Барсик',
]

/** How far the page under the window is scrolled: the window itself and every Framework7 page content. */
const pageScroll = (page: Page) =>
  page.evaluate(() => [window.scrollY, ...[...document.querySelectorAll('.page-content')].map((el) => el.scrollTop)])

/** A conversation from home: the words typed, the reply waited for; the conversation stays open. */
async function talk(page: Page, words: string, options: { unsaved?: boolean; withoutMemory?: boolean } = {}): Promise<void> {
  const here = page.locator('.page-current')
  await openTab(page, 'Главная')
  if (options.withoutMemory) await here.getByTestId('incognito').locator('.toggle').click()
  if (options.unsaved) await here.getByTestId('unsaved-toggle').check()
  await button(page, 'Поговорить').click()
  await expect(here.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await here.getByRole('button', { name: 'Писать текстом' }).click()
  await here.getByPlaceholder('Напиши, что происходит').fill(words)
  await here.getByRole('button', { name: 'Отправить' }).click()
  // Framework7 draws a sent line twice once the server has acknowledged it, so the count itself is not asserted.
  await expect(here.locator('.message-sent').first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => here.locator('.message-received').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  // Ending in the middle of a reply would only test the fallback timer.
  await page.waitForTimeout(1500)
}

/** Ends the open conversation; the window "Спасибо, что поговорил(а)" stays open. */
async function endAndWait(page: Page): Promise<void> {
  await page.locator('.page-current').getByRole('button', { name: 'Завершить разговор' }).click()
  await sheetButton(page, 'Завершить').click()
  await expect(closing(page)).toBeVisible({ timeout: 30_000 })
  await expect(closing(page)).toContainText('Спасибо, что поговорил(а)')
}

async function closeWindow(page: Page): Promise<void> {
  await closing(page).getByText('ОК').click()
  await expect(closing(page)).toHaveCount(0)
  // Home is back: a tap on a tab while the screen is still sliding out is lost.
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 20_000 })
}

/** Profile → Память. The tab keeps its pages: when the person has been there already, it opens on the memory page itself. */
async function openNotes(page: Page) {
  await openTab(page, 'Профиль')
  const memory = page.locator('.page-current[data-name="memory"]')
  const row = page.locator('.page-current').getByTestId('row-memory')
  await expect(memory.or(row)).toBeVisible({ timeout: 20_000 })
  if (await row.isVisible()) await row.click()
  await expect(memory).toBeVisible()
  return memory
}

test('блок «Я запомнил» в окне завершения: заметки этого разговора, «Убрать», сбой «Убрать», все заметки с прокруткой в блоке', async ({
  page,
}) => {
  test.setTimeout(360_000)
  await openApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page, false)

  // An earlier conversation leaves a note of its own: it must not show up in the block of the next one.
  await talk(page, RECAP_ONE)
  await endAndWait(page)
  await closeWindow(page)

  await talk(page, SAID)
  await expect(page.locator('.page-current').locator('.message-sent').first()).toContainText('Алекс')
  await step(page, 'recap-said', 'Человек рассказал о себе в разговоре: имя и работа')

  // The window opens at once, with no block: the final pass is still going.
  await endAndWait(page)
  await expect(recap(page)).toHaveCount(0)
  await step(page, 'recap-window-pending', 'Разговор завершён: окно открыто, блока «Я запомнил» ещё нет')

  // Then the notes of this conversation, each with «Убрать»; the earlier one is not among them.
  await expect(recap(page)).toBeVisible({ timeout: 30_000 })
  await expect(recap(page).getByRole('heading', { name: 'Я запомнил' })).toBeVisible()
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(2)
  await expect(recapNote(page, NAME_NOTE)).toBeVisible()
  await expect(recapNote(page, WORK_NOTE)).toBeVisible()
  await expect(recap(page)).not.toContainText(RECAP_ONE_NOTE)
  await expect(recap(page).getByTestId('memory-recap-remove')).toHaveCount(2)
  await expect(recapLate(page)).toHaveCount(0)
  // Two notes are fewer than three: nothing to scroll and no empty room under them.
  expect(await recapList(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  await expectInsideViewport(page, closing(page))
  await step(page, 'recap-block', 'Блок «Я запомнил»: две заметки из этого разговора, у каждой «Убрать»')

  // «Убрать» that does not go through: the note stays and the error is beside it.
  await page.route('**/api/memory/facts/*', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      : route.fallback(),
  )
  await recapNote(page, NAME_NOTE).getByTestId('memory-recap-remove').click()
  await expect(recapNote(page, NAME_NOTE).getByTestId('memory-recap-error')).toBeVisible()
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(2)
  await step(page, 'recap-remove-failed', 'Удаление не прошло: заметка осталась в блоке, рядом ошибка')
  await page.unroute('**/api/memory/facts/*')

  // «Убрать» that does: gone from the block at once, without «Вернуть».
  await recapNote(page, NAME_NOTE).getByTestId('memory-recap-remove').click()
  await expect(recapNote(page, NAME_NOTE)).toHaveCount(0)
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(1)
  await expect(recapNote(page, WORK_NOTE)).toBeVisible()
  await expect(page.getByTestId('memory-undo')).toHaveCount(0)
  await step(page, 'recap-note-removed', 'После «Убрать» заметка пропала из блока, другая на месте')

  // …and from the sheet "Что помнит Рядом": the earlier note and the other one are still there.
  await closeWindow(page)
  const memory = await openNotes(page)
  await memory.getByTestId('memory-open-notes').click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByTestId('memory-note')).toHaveCount(2, { timeout: 20_000 })
  await expect(sheet.getByTestId('memory-note').filter({ hasText: RECAP_ONE_NOTE })).toBeVisible()
  await expect(sheet.getByTestId('memory-note').filter({ hasText: WORK_NOTE })).toBeVisible()
  await expect(sheet.getByTestId('memory-note').filter({ hasText: NAME_NOTE })).toHaveCount(0)
  await step(page, 'recap-sheet-after-remove', 'В листе «Что помнит Рядом» убранной заметки нет, остальные на месте')
  await sheetButton(page, 'Закрыть').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)

  // Many notes: all of them are in the block, about three in view, the rest by scrolling the list itself.
  await talk(page, RECAP_MANY)
  await endAndWait(page)
  await expect(recap(page)).toBeVisible({ timeout: 30_000 })
  await expect(recapNotes(page)).toHaveCount(MANY_NOTES.length)
  await expect(recapNotes(page).locator('[data-testid="memory-recap-text"]')).toHaveText(MANY_NOTES)
  await expect(recap(page).getByTestId('memory-recap-more')).toHaveCount(0)
  await expect(recapList(page)).toHaveAttribute('role', 'list')
  await expect(recapList(page)).toHaveAttribute('aria-label', 'Заметки этого разговора')
  await expect(recapList(page)).toHaveAttribute('tabindex', '0')
  // About three rows: the first ones whole, the last ones cut off by the list's own edge, which is why the list scrolls.
  for (const text of MANY_NOTES.slice(0, 3)) await expect(recapNote(page, text)).toBeInViewport({ ratio: 0.9 })
  for (const text of MANY_NOTES.slice(4)) await expect(recapNote(page, text)).not.toBeInViewport()
  const before = await recapList(page).evaluate((el) => ({ room: el.scrollHeight - el.clientHeight, top: el.scrollTop, height: el.clientHeight }))
  expect(before.room).toBeGreaterThan(40)
  expect(before.top).toBe(0)
  const rowHeight = (await recapNotes(page).first().boundingBox())!.height
  expect(before.height).toBeLessThan(rowHeight * 5)
  // The window as a whole stays on the screen.
  await expectInsideViewport(page, closing(page))
  await step(page, 'recap-many-notes', 'Из разговора вышло шесть заметок: в блоке видны три, дальше список прокручивается внутри блока')

  // The wheel over the list scrolls the list, and not the page under the window.
  const pageBefore = await pageScroll(page)
  await recapList(page).hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => recapList(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1)
  await expect(recapNote(page, MANY_NOTES.at(-1)!)).toBeInViewport({ ratio: 0.9 })
  await expect(recapNote(page, MANY_NOTES[0]!)).not.toBeInViewport()
  expect(await pageScroll(page)).toEqual(pageBefore)
  await expectInsideViewport(page, closing(page))
  await step(page, 'recap-many-scrolled', 'Список прокручен до конца: видна последняя заметка, окно и страница под ним на месте')

  // The list takes the keyboard: Home scrolls it back up.
  await recapList(page).focus()
  await page.keyboard.press('Home')
  await expect.poll(() => recapList(page).evaluate((el) => el.scrollTop)).toBe(0)
  await expect(recapNote(page, MANY_NOTES[0]!)).toBeInViewport({ ratio: 0.9 })

  // «Убрать» in the middle of the list: that note goes, the others stay in their order, the block shrinks.
  const heightWith6 = (await recapList(page).boundingBox())!.height
  await recapNote(page, MANY_NOTES[1]!).getByTestId('memory-recap-remove').click()
  await expect(recapNotes(page)).toHaveCount(MANY_NOTES.length - 1)
  await expect(recapNote(page, MANY_NOTES[1]!)).toHaveCount(0)
  await expect(recapNotes(page).locator('[data-testid="memory-recap-text"]')).toHaveText(
    MANY_NOTES.filter((_, index) => index !== 1),
  )
  await expect(recap(page).getByTestId('memory-recap-more')).toHaveCount(0)
  expect((await recapList(page).boundingBox())!.height).toBeLessThanOrEqual(heightWith6)
  // Down to three: the list no longer scrolls and has no empty room.
  for (const text of [MANY_NOTES[3]!, MANY_NOTES[4]!]) {
    await recapNote(page, text).getByTestId('memory-recap-remove').click()
    await expect(recapNote(page, text)).toHaveCount(0)
  }
  await expect(recapNotes(page)).toHaveCount(3)
  expect(await recapList(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  // Nothing left: the block goes, and the window is as it was.
  for (const text of [MANY_NOTES[0]!, MANY_NOTES[2]!, MANY_NOTES[5]!]) {
    await recapNote(page, text).getByTestId('memory-recap-remove').click()
    await expect(recapNote(page, text)).toHaveCount(0)
  }
  await expect(recap(page)).toHaveCount(0)
  await expect(closing(page)).toBeVisible()
  await closeWindow(page)
})

test('«Ещё записываю»: заметки не готовы за 30 секунд — под текстом окна спокойная строка, до этого ничего', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page, false)

  // The final pass never finishes: the agent keeps saying `pending`.
  let asked = 0
  await page.route('**/api/memory/changes*', (route) => {
    asked += 1
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: true, result: { status: 'pending', reason: null, items: [] } }),
    })
  })

  await talk(page, SAID)
  await endAndWait(page)
  const opened = Date.now()
  await expect.poll(() => asked).toBeGreaterThan(0)

  // Within the half minute the window is as it was: no block, no line, nothing that flickers.
  await page.waitForTimeout(20_000)
  await expect(recap(page)).toHaveCount(0)
  await expect(recapLate(page)).toHaveCount(0)
  await expect(closing(page).getByText('ОК')).toBeVisible()

  // Then one calm line under the text, with nothing to press.
  await expect(recapLate(page)).toBeVisible({ timeout: 20_000 })
  expect(Date.now() - opened).toBeGreaterThan(24_000)
  await expect(recapLate(page)).toHaveText(STILL_WRITING)
  await expect(recapLate(page)).toHaveAttribute('aria-live', 'polite')
  await expect(recapLate(page).getByRole('button')).toHaveCount(0)
  await expect(recap(page)).toHaveCount(0)
  await expectInsideViewport(page, closing(page))
  await step(page, 'recap-still-writing', 'Заметки не успели записаться за 30 секунд: под текстом окна строка «Ещё записываю…», кнопок нет')

  // The poll has stopped, and the line stays.
  const stopped = asked
  expect(stopped).toBeLessThanOrEqual(11)
  await page.waitForTimeout(7_000)
  expect(asked).toBe(stopped)
  await expect(recapLate(page)).toBeVisible()
  await closeWindow(page)
})

test('блока «Я запомнил» нет: «Без памяти», «Не сохранять», пауза, разговор без заметок', async ({ page }) => {
  test.setTimeout(360_000)
  await openApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page, false)

  // The block would come within a poll or two (3 s apart) and the mock is done in 1.5 s: a wait past both.
  const noBlock = async () => {
    await page.waitForTimeout(5_000)
    await expect(recap(page)).toHaveCount(0)
    await expect(recapLate(page)).toHaveCount(0)
    await expect(closing(page)).toBeVisible()
  }

  // A conversation «Без памяти» says nothing to remember, however much the person told.
  await talk(page, SAID, { withoutMemory: true })
  await endAndWait(page)
  await noBlock()
  await step(page, 'recap-none-incognito', 'Разговор «Без памяти»: окно завершения как прежде, блока нет')
  await closeWindow(page)

  // A conversation held unsaved: the same.
  await talk(page, SAID, { unsaved: true })
  await endAndWait(page)
  await noBlock()
  await closeWindow(page)

  // Nothing to remember in what was said: the block does not come up empty.
  await talk(page, 'Привет, как дела')
  await endAndWait(page)
  await noBlock()
  await closeWindow(page)

  // Memory on pause: the person told about themselves, and nothing is kept, so nothing is listed.
  const memory = await openNotes(page)
  await memory.getByTestId('memory-switch').locator('.toggle').click()
  await expect(memory.getByTestId('memory-switch').locator('input[type="checkbox"]')).not.toBeChecked()
  await talk(page, SAID)
  await endAndWait(page)
  await noBlock()
  await closeWindow(page)
  const afterPause = await openNotes(page)
  await afterPause.getByTestId('memory-open-notes').click()
  await expect(page.locator('.sheet-modal.modal-in').getByTestId('memory-empty')).toBeVisible()
})
