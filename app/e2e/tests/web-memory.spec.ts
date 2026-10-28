import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import {
  dialogInput,
  expectNoHorizontalOverflow,
  goTo,
  homeInput,
  messages,
  modal,
  modalButton,
  openProfile,
  openWebApp,
  startAnonymously,
  talkButton,
} from '../support/web'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'

/**
 * Memory in the web app, the notes model (PROTEUS-242, REQ-MEM-*): turning it on through its own consent
 * sheet, a conversation in which the person tells about themselves, the sheet "Что помнит Рядом" with
 * the notes in groups (correct, "×" with "Вернуть", "Скажи, что поправить или убрать"), the three
 * switches (the sensitive one decides whether "плохо сплю" becomes a note), the pause, the download and
 * "Удалить всю память". The agent is the mock (`dev/agent-mock/memory-notes.mjs`): its "extraction" turns
 * the person's phrases into notes a moment (1.5 s) after they are said, and answers `GET /memory/changes` like the real agent: `pending`
 * until the final pass after the end is done, then the notes of that conversation (the block "Я запомнил" of the closing window).
 */

const INTRO = 'Меня зовут Алекс, я работаю в продажах'
const NAME = 'Зовут Алекс'
const WORK = 'Работает в продажах'
const SLEEP = 'Последние недели плохо сплю'
const SLEEP_NOTE = 'Последние недели плохо спит'

/** Starts a conversation from home with the typed words, waits for the reply, ends it and returns home. */
async function talkAndEnd(page: Page, words: string): Promise<void> {
  await homeInput(page).fill(words)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialogInput(page)).toBeVisible()

  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  // The mock "extracts" 1.5 s after the words; a little more, and the notes are there.
  await page.waitForTimeout(2_500)
}

async function openMemory(page: Page): Promise<void> {
  await openProfile(page)
  await page.getByTestId('row-memory').click()
  await expect(page).toHaveURL(/\/profile\/memory$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Память', exact: true })).toBeVisible()
}

const sheet = (page: Page) => page.getByTestId('memory-sheet')
const notes = (page: Page) => sheet(page).getByTestId('memory-note')
const noteTexts = (page: Page) => sheet(page).getByTestId('memory-note-text')
const memorySwitch = (page: Page) => page.getByTestId('memory-switch').getByRole('checkbox')
const sensitiveSwitch = (page: Page) => page.getByTestId('memory-switch-sensitive').getByRole('checkbox')
const searchSwitch = (page: Page) => page.getByTestId('memory-switch-chat-search').getByRole('checkbox')

async function openSheet(page: Page): Promise<void> {
  await page.getByTestId('memory-open').click()
  await expect(sheet(page)).toBeVisible()
}

async function closeSheet(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
}

/** The texts start hidden behind "Показать" in a browser. */
async function reveal(page: Page): Promise<void> {
  if (await page.getByTestId('memory-reveal').getByText('Показать').count()) {
    await page.getByTestId('memory-reveal').click()
  }
}

test('память в вебе: согласие → разговор → лист «Что помнит Рядом» → правка, «×», «Скажи, что поправить» → переключатели, пауза, скачать, удалить всё', async ({
  page,
  shot,
}) => {
  test.setTimeout(360_000)
  await openWebApp(page)
  await startAnonymously(page)

  // ── off by default: no "Без памяти" on home, the two lower switches wait for the first ───────
  await expect(page.getByTestId('incognito')).toHaveCount(0)
  await openMemory(page)
  await expect(memorySwitch(page)).not.toBeChecked()
  await expect(sensitiveSwitch(page)).toBeDisabled()
  await expect(searchSwitch(page)).toBeDisabled()
  await shot(page, 'web-memory-off')

  // ── the consent sheet: a document of its own, and "Не сейчас" leaves memory off ─────────────
  await memorySwitch(page).click()
  await expect(modal(page).getByRole('heading', { name: 'Память' })).toBeVisible()
  await expect(modal(page)).toContainText('Память можно не включать')
  await shot(page, 'web-memory-consent')
  await modalButton(page, 'Не сейчас').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(memorySwitch(page)).not.toBeChecked()

  await memorySwitch(page).click()
  await modalButton(page, 'Включить память').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(memorySwitch(page)).toBeChecked()
  await expect(sensitiveSwitch(page)).toBeEnabled()
  await expect(sensitiveSwitch(page)).not.toBeChecked()
  await expect(searchSwitch(page)).toBeEnabled()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-memory-on')

  // ── the sheet is empty at first ─────────────────────────────────────────────────────────────
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toContainText('Пока пусто')
  await shot(page, 'web-memory-sheet-empty')
  await closeSheet(page)

  // ── a conversation, and the notes it left, in groups ────────────────────────────────────────
  await goTo(page, 'Новый разговор')
  await expect(page.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'false')
  await talkAndEnd(page, INTRO)

  await openMemory(page)
  await openSheet(page)
  await expect(notes(page)).toHaveCount(2)
  await expect(noteTexts(page).first()).toHaveText('Текст скрыт')
  await shot(page, 'web-memory-sheet-hidden')
  await reveal(page)
  await expect(sheet(page).locator('[data-group="about"]')).toContainText(NAME)
  await expect(sheet(page).locator('[data-group="work"]')).toContainText(WORK)
  await expect(sheet(page).getByRole('heading', { name: 'Работа и дела' })).toBeVisible()
  await expect(sheet(page).getByTestId('memory-note-date').first()).not.toBeEmpty()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-memory-sheet-notes')

  // ── correct a note: a rule refuses a medicine, a plain text is saved ────────────────────────
  const work = sheet(page).locator('[data-group="work"]').getByTestId('memory-note')
  await work.getByTestId('memory-note-edit').click()
  await work.getByTestId('memory-edit-input').fill('Принимает антидепрессанты')
  await work.getByTestId('memory-edit-save').click()
  await expect(work.getByTestId('memory-edit-error')).toHaveText('Так запомнить не получится')
  await shot(page, 'web-memory-edit-refused')
  await work.getByTestId('memory-edit-input').fill('Работает в логистике')
  await work.getByTestId('memory-edit-save').click()
  await expect(work.getByTestId('memory-note-text')).toHaveText('Работает в логистике')
  await shot(page, 'web-memory-edit-saved')

  // ── "Скажи, что поправить": «не X, а Y» changes the text ────────────────────────────────────
  await sheet(page).getByTestId('memory-instruction-input').fill('не логистике, а продажах')
  await sheet(page).getByTestId('memory-instruction-send').click()
  await expect(sheet(page).getByTestId('memory-instruction-result')).toHaveText('Изменено: 1')
  await expect(work.getByTestId('memory-note-text')).toHaveText(WORK)
  await shot(page, 'web-memory-instruction-fixed')

  // ── "×": five seconds for "Вернуть", then it is gone for good ───────────────────────────────
  const name = sheet(page).locator('[data-group="about"]').getByTestId('memory-note')
  await name.getByTestId('memory-note-delete').click()
  await expect(sheet(page).getByTestId('memory-undo')).toBeVisible()
  await shot(page, 'web-memory-undo')
  await sheet(page).getByTestId('memory-undo-button').click()
  await expect(name.getByTestId('memory-note-text')).toHaveText(NAME)
  await name.getByTestId('memory-note-delete').click()
  await expect(sheet(page).getByTestId('memory-undo')).toBeVisible()
  await expect(sheet(page).getByTestId('memory-undo')).toHaveCount(0, { timeout: 15_000 })
  await expect(notes(page)).toHaveCount(1)

  // ── "Скажи, что убрать": the last note goes, the sheet is empty again ───────────────────────
  await sheet(page).getByTestId('memory-instruction-input').fill('Убери тему про продажи')
  await sheet(page).getByTestId('memory-instruction-send').click()
  await expect(sheet(page).getByTestId('memory-instruction-result')).toHaveText('Удалено: 1')
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible()
  await shot(page, 'web-memory-instruction-removed')
  // …also after a reload.
  await page.reload()
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible({ timeout: 20_000 })
  await closeSheet(page)

  // ── "Запоминать чувствительное": off, «плохо сплю» is not remembered ────────────────────────
  await goTo(page, 'Новый разговор')
  await talkAndEnd(page, SLEEP)
  await openMemory(page)
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible()
  await closeSheet(page)

  // on: the same words become a note in «Самочувствие»
  await sensitiveSwitch(page).click()
  await expect(sensitiveSwitch(page)).toBeChecked()
  await shot(page, 'web-memory-sensitive-on')
  await goTo(page, 'Новый разговор')
  await talkAndEnd(page, SLEEP)
  await openMemory(page)
  await expect(sensitiveSwitch(page)).toBeChecked()
  await openSheet(page)
  await reveal(page)
  await expect(sheet(page).locator('[data-group="wellbeing"]')).toContainText(SLEEP_NOTE)
  await expect(sheet(page).getByRole('heading', { name: 'Самочувствие' })).toBeVisible()
  await shot(page, 'web-memory-sheet-wellbeing')
  await closeSheet(page)

  // ── the pause: the notes stay, the two lower switches wait ──────────────────────────────────
  await memorySwitch(page).click()
  await expect(memorySwitch(page)).not.toBeChecked()
  await expect(sensitiveSwitch(page)).toBeDisabled()
  await expect(searchSwitch(page)).toBeDisabled()
  await expect(sensitiveSwitch(page)).toBeChecked()
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-paused')).toContainText('Память на паузе')
  await expect(notes(page)).toHaveCount(1)
  await shot(page, 'web-memory-paused')
  await closeSheet(page)
  // back on without the consent sheet: it was accepted already
  await memorySwitch(page).click()
  await expect(memorySwitch(page)).toBeChecked()
  await expect(modal(page)).toHaveCount(0)

  // ── "Опираться на прошлые разговоры" is its own switch ──────────────────────────────────────
  await expect(searchSwitch(page)).toBeChecked()
  await searchSwitch(page).click()
  await expect(searchSwitch(page)).not.toBeChecked()
  await page.reload()
  await expect(searchSwitch(page)).not.toBeChecked()
  await expect(memorySwitch(page)).toBeChecked()
  await searchSwitch(page).click()
  await expect(searchSwitch(page)).toBeChecked()
  // Turned on again, the index is rebuilt: the section says so, reads again by itself and the label goes away.
  await expect(page.getByTestId('memory-reindexing')).toHaveText('Готовлю память о прошлых разговорах…')
  await shot(page, 'web-memory-reindexing')
  await expect(page.getByTestId('memory-reindexing')).toHaveCount(0, { timeout: 30_000 })

  // ── sensitive off: the sensitive notes are deleted ──────────────────────────────────────────
  await sensitiveSwitch(page).click()
  await expect(sensitiveSwitch(page)).not.toBeChecked()
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible()
  await closeSheet(page)
  await sensitiveSwitch(page).click()
  await expect(sensitiveSwitch(page)).toBeChecked()

  // ── the download, then "Удалить всю память": the notes go, the switches stay ────────────────
  await goTo(page, 'Новый разговор')
  await talkAndEnd(page, INTRO)
  await openMemory(page)
  const downloading = page.waitForEvent('download')
  await page.getByTestId('memory-export').click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^ryadom-memory-\d{4}-\d{2}-\d{2}\.json$/)
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    notes: { text: string }[]
  }
  expect(exported.notes.map((item) => item.text).sort()).toEqual([NAME, WORK].sort())

  await page.getByTestId('memory-forget-all').click()
  await expect(modal(page)).toContainText('Удалить всю память?')
  await shot(page, 'web-memory-forget-all')
  await page.getByTestId('memory-forget-all-confirm').click()
  await expect(modal(page)).toHaveCount(0)
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible()
  await closeSheet(page)
  await expect(memorySwitch(page)).toBeChecked()
  await expect(sensitiveSwitch(page)).toBeChecked()
  await page.reload()
  await expect(memorySwitch(page)).toBeChecked()
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible({ timeout: 20_000 })
  await closeSheet(page)

  // "Как это работает" is a sheet of its own.
  await page.getByTestId('memory-how').click()
  await expect(modal(page).getByRole('heading', { name: 'Как это работает' })).toBeVisible()
  await shot(page, 'web-memory-how')
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
})

test('память в вебе: разговор «Без памяти» ничего не оставляет в листе', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await openWebApp(page)
  await startAnonymously(page)
  await openMemory(page)
  await memorySwitch(page).click()
  await modalButton(page, 'Включить память').click()
  await expect(memorySwitch(page)).toBeChecked()

  await goTo(page, 'Новый разговор')
  await page.getByTestId('incognito-toggle').click()
  await expect(page.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('incognito')).toContainText('Этот разговор я не запомню')
  await homeInput(page).fill(INTRO)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(page.getByTestId('dialog-incognito')).toContainText('Без памяти')
  // The button with the notes is not in a conversation held without memory.
  await expect(page.getByTestId('memory-nav')).toHaveCount(0)
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await shot(page, 'web-memory-incognito-dialog')
  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  // The mock is done in about a second and a half; well past it, still nothing.
  await page.waitForTimeout(4_000)
  await openMemory(page)
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible()
  await shot(page, 'web-memory-incognito-sheet')
})

test('лист «Что помнит Рядом» из разговора: кнопка в шапке, тексты скрыты, новая заметка появляется без перезапуска листа', async ({
  page,
  shot,
}) => {
  test.setTimeout(180_000)
  await openWebApp(page)
  await startAnonymously(page)
  await openMemory(page)
  await memorySwitch(page).click()
  await modalButton(page, 'Включить память').click()
  await expect(memorySwitch(page)).toBeChecked()

  await goTo(page, 'Новый разговор')
  await expect(page.getByTestId('memory-nav')).toHaveCount(0) // home is not a conversation
  await homeInput(page).fill(INTRO)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('memory-nav')).toBeVisible()
  await shot(page, 'web-memory-dialog-button')

  // The sheet opens over the conversation; the texts are behind "Показать" as in the profile. The note the mock makes
  // 1.5 s after the words appears on the open sheet by itself, within the refresh period of 10 s.
  await page.getByTestId('memory-nav').click()
  await expect(sheet(page)).toBeVisible()
  await expect(notes(page)).toHaveCount(2, { timeout: 15_000 })
  await expect(noteTexts(page).first()).toHaveText('Текст скрыт')
  await shot(page, 'web-memory-dialog-sheet-hidden')
  await reveal(page)
  await expect(noteTexts(page).filter({ hasText: NAME })).toHaveCount(1)
  await expect(noteTexts(page).filter({ hasText: WORK })).toHaveCount(1)
  await shot(page, 'web-memory-dialog-sheet')
  await closeSheet(page)
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
})

const invite = (page: Page) => page.getByTestId('memory-invite')

test('приглашение «Рядом теперь запоминает важное»: «Не сейчас» закрывает насовсем, «Включить» ведёт через согласие', async ({
  browser,
  page,
  shot,
}) => {
  test.setTimeout(180_000)
  // REQ-MEM: nothing is chosen in advance; "Не сейчас" is remembered in this browser.
  await openWebApp(page)
  await startAnonymously(page, { keepMemoryInvite: true })
  await expect(invite(page)).toBeVisible({ timeout: 20_000 })
  await expect(modal(page)).toContainText('Рядом теперь запоминает важное')
  await expect(modal(page).getByRole('checkbox')).toHaveCount(0)
  await shot(page, 'web-memory-invite')
  await modalButton(page, 'Не сейчас').click()
  await expect(modal(page)).toHaveCount(0)
  await page.reload()
  await expect(talkButton(page)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2_000)
  await expect(invite(page)).toHaveCount(0)
  // Not asked again, and memory stayed off.
  await openMemory(page)
  await expect(memorySwitch(page)).not.toBeChecked()

  // Another person: "Включить" opens the consent sheet, accepting it turns memory on.
  const other = await browser.newContext(test.info().project.use)
  try {
    const second = await other.newPage()
    await openWebApp(second)
    await startAnonymously(second, { keepMemoryInvite: true })
    await expect(invite(second)).toBeVisible({ timeout: 20_000 })
    await modalButton(second, 'Включить').click()
    await expect(second.getByTestId('memory-consent')).toBeVisible()
    await modalButton(second, 'Включить память').click()
    await expect(modal(second)).toHaveCount(0)
    await openMemory(second)
    await expect(memorySwitch(second)).toBeChecked()
  } finally {
    await other.close()
  }
})

test('«Запомнил: … · Убрать» в разговоре: новая чувствительная заметка → строка → «Убрать» удаляет; без «чувствительного» строки нет', async ({
  page,
  shot,
}) => {
  test.setTimeout(240_000)
  await openWebApp(page)
  await startAnonymously(page)
  await openMemory(page)
  await memorySwitch(page).click()
  await modalButton(page, 'Включить память').click()
  await expect(memorySwitch(page)).toBeChecked()

  // Sensitive off: the notice never shows (the poll is not even started).
  await goTo(page, 'Новый разговор')
  await homeInput(page).fill(SLEEP)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(14_000)
  await expect(page.getByTestId('memory-notice')).toHaveCount(0)
  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)

  await openMemory(page)
  await sensitiveSwitch(page).click()
  await expect(sensitiveSwitch(page)).toBeChecked()

  await goTo(page, 'Новый разговор')
  await homeInput(page).fill(SLEEP)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  const notice = page.getByTestId('memory-notice')
  await expect(notice).toContainText(`Запомнил: ${SLEEP_NOTE}`, { timeout: 25_000 })
  await expect(notice).toContainText('Убрать')
  await shot(page, 'web-memory-notice')
  await page.getByTestId('memory-notice-undo').click()
  await expect(notice).toHaveCount(0)
  await shot(page, 'web-memory-notice-removed')

  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  await openMemory(page)
  await openSheet(page)
  await expect(sheet(page)).not.toContainText(SLEEP_NOTE)
})

// ── the block "Я запомнил" in the window after a conversation (PROTEUS-242, D16) ─────────────────

const RECAP_ONE = 'Люблю море'
const RECAP_ONE_NOTE = 'Любит море'
// One message, six notes: the mock takes every phrase pattern in a line.
const RECAP_MANY =
  'Меня зовут Борис, я работаю в школе, у меня есть сестра Маша, люблю горы, не хочу говорить про отца, запомни, что у меня кот Барсик'

const recap = (page: Page) => modal(page).getByTestId('memory-recap')
const recapNote = (page: Page, text: string) =>
  recap(page).getByTestId('memory-recap-note').filter({ hasText: text })

async function turnMemoryOn(page: Page): Promise<void> {
  await openMemory(page)
  await memorySwitch(page).click()
  await modalButton(page, 'Включить память').click()
  await expect(memorySwitch(page)).toBeChecked()
}

/** A conversation from home: the words typed, the reply waited for; the conversation stays open. */
async function talk(page: Page, words: string): Promise<void> {
  await homeInput(page).fill(words)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialogInput(page)).toBeVisible()
}

/** Ends the open conversation and waits for the window "Спасибо, что поговорил(а)"; the window stays open. */
async function endAndWait(page: Page): Promise<void> {
  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
}

async function closeWindow(page: Page): Promise<void> {
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
}

test('блок «Я запомнил» в окне завершения: заметки этого разговора, «Убрать», сбой «Убрать», больше четырёх', async ({
  page,
}) => {
  test.setTimeout(360_000)
  await openWebApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page)

  // An earlier conversation leaves a note of its own: it must not show up in the block of the next one.
  await goTo(page, 'Новый разговор')
  await talkAndEnd(page, RECAP_ONE)

  await goTo(page, 'Новый разговор')
  await talk(page, INTRO)
  await expect(messages(page, 'user').first()).toContainText('Алекс')
  await step(page, 'recap-said', 'Человек рассказал о себе в разговоре: имя и работа')

  // The window opens at once, with no block: the final pass is still going.
  await endAndWait(page)
  await expect(recap(page)).toHaveCount(0)
  await expect(page.getByTestId('alert-ok')).toBeEnabled()
  await step(page, 'recap-window-pending', 'Разговор завершён: окно открыто, блока «Я запомнил» ещё нет')

  // Then the notes of this conversation, each with «Убрать»; the earlier one is not among them.
  await expect(recap(page)).toBeVisible({ timeout: 30_000 })
  await expect(recap(page).getByRole('heading', { name: 'Я запомнил' })).toBeVisible()
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(2)
  await expect(recapNote(page, NAME)).toBeVisible()
  await expect(recapNote(page, WORK)).toBeVisible()
  await expect(recap(page)).not.toContainText(RECAP_ONE_NOTE)
  await expect(recap(page).getByTestId('memory-recap-remove')).toHaveCount(2)
  await expect(recap(page).getByTestId('memory-recap-more')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
  await step(page, 'recap-block', 'Блок «Я запомнил»: две заметки из этого разговора, у каждой «Убрать»')

  // «Убрать» that does not go through: the note stays and the error is beside it.
  await page.route('**/api/memory/facts/*', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      : route.fallback(),
  )
  await recapNote(page, NAME).getByTestId('memory-recap-remove').click()
  await expect(recapNote(page, NAME).getByTestId('memory-recap-error')).toBeVisible()
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(2)
  await step(page, 'recap-remove-failed', 'Удаление не прошло: заметка осталась в блоке, рядом ошибка')
  await page.unroute('**/api/memory/facts/*')

  // «Убрать» that does: gone from the block at once, without «Вернуть».
  await recapNote(page, NAME).getByTestId('memory-recap-remove').click()
  await expect(recapNote(page, NAME)).toHaveCount(0)
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(1)
  await expect(recapNote(page, WORK)).toBeVisible()
  await expect(page.getByTestId('memory-undo')).toHaveCount(0)
  await step(page, 'recap-note-removed', 'После «Убрать» заметка пропала из блока, другая на месте')

  // …and from the sheet "Что помнит Рядом", the earlier note and the other one are still there.
  await closeWindow(page)
  await openMemory(page)
  await openSheet(page)
  await reveal(page)
  await expect(notes(page)).toHaveCount(2)
  await expect(sheet(page)).toContainText(RECAP_ONE_NOTE)
  await expect(sheet(page)).toContainText(WORK)
  await expect(sheet(page)).not.toContainText(NAME)
  await step(page, 'recap-sheet-after-remove', 'В листе «Что помнит Рядом» убранной заметки нет, остальные на месте')
  await closeSheet(page)

  // More than four notes: four in the block and a line about the rest; «Убрать» brings the next one up.
  await goTo(page, 'Новый разговор')
  await talk(page, RECAP_MANY)
  await endAndWait(page)
  await expect(recap(page)).toBeVisible({ timeout: 30_000 })
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(4)
  await expect(recap(page).getByTestId('memory-recap-more')).toContainText('в «Что помнит Рядом»')
  await expectNoHorizontalOverflow(page)
  await step(page, 'recap-more-than-four', 'Из разговора вышло шесть заметок: в блоке четыре и подпись про остальные')
  await recap(page).getByTestId('memory-recap-remove').first().click()
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(4)
  await expect(recap(page).getByTestId('memory-recap-more')).toBeVisible()
  await recap(page).getByTestId('memory-recap-remove').first().click()
  await expect(recap(page).getByTestId('memory-recap-note')).toHaveCount(4)
  await expect(recap(page).getByTestId('memory-recap-more')).toHaveCount(0)
  await closeWindow(page)
})

test('блока «Я запомнил» нет: «Без памяти», «Не сохранять», пауза, разговор без заметок', async ({ page }) => {
  test.setTimeout(360_000)
  await openWebApp(page)
  await startAnonymously(page)
  await turnMemoryOn(page)

  // The block would come within a poll or two (3 s apart) and the mock is done in 1.5 s: a wait past both.
  const noBlock = async () => {
    await page.waitForTimeout(5_000)
    await expect(recap(page)).toHaveCount(0)
    await expect(page.getByTestId('alert-ok')).toBeVisible()
  }

  // A conversation «Без памяти» says nothing to remember, however much the person told.
  await goTo(page, 'Новый разговор')
  await page.getByTestId('incognito-toggle').click()
  await expect(page.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'true')
  await talk(page, INTRO)
  await endAndWait(page)
  await noBlock()
  await step(page, 'recap-none-incognito', 'Разговор «Без памяти»: окно завершения как прежде, блока нет')
  await closeWindow(page)

  // A conversation held unsaved: the same.
  await goTo(page, 'Новый разговор')
  await page.getByTestId('unsaved-toggle').check()
  await talk(page, INTRO)
  await endAndWait(page)
  await noBlock()
  await closeWindow(page)

  // Nothing to remember in what was said: the block does not come up empty.
  await goTo(page, 'Новый разговор')
  await talk(page, 'Привет, как дела')
  await endAndWait(page)
  await noBlock()
  await closeWindow(page)

  // Memory on pause: the person told about themselves, and nothing is kept, so nothing is listed.
  await openMemory(page)
  await memorySwitch(page).click()
  await expect(memorySwitch(page)).not.toBeChecked()
  await goTo(page, 'Новый разговор')
  await talk(page, INTRO)
  await endAndWait(page)
  await noBlock()
  await closeWindow(page)
  await openMemory(page)
  await openSheet(page)
  await expect(sheet(page).getByTestId('memory-sheet-empty')).toBeVisible()
})
