import type { Page } from '@playwright/test'
import {
  dialogInput,
  goTo,
  homeInput,
  messages,
  modal,
  modalButton,
  openProfile,
  openWebApp,
  startAnonymously,
} from '../support/web'
import { expect, test } from '../support/fixtures'

/**
 * Memory on the REAL agent (PROTEUS-242): the web app → the API → the agent on Python with the model of the
 * production proxy → notes in PostgreSQL → the memory block in the next conversation. It runs only with
 * `E2E_REAL_AGENT_URL` (a locally started agent with `MEMORY_NOTES_ENABLED=true`, `LLM_MODE=proxy`) and tests
 * what a mock cannot: that the model makes notes from the words, that the code refuses what is forbidden,
 * that "Убери тему…" is understood by the model, and that the next conversation knows the person.
 * The texts of the notes depend on the model, so the checks look for the meaning (a name, a word), not a phrase.
 */

test.skip(!process.env.E2E_REAL_AGENT_URL, 'E2E_REAL_AGENT_URL не задан: сценарий идёт только на настоящем агенте')

const sheet = (page: Page) => page.getByTestId('memory-sheet')
const memorySwitch = (page: Page) => page.getByTestId('memory-switch').getByRole('checkbox')
const sensitiveSwitch = (page: Page) => page.getByTestId('memory-switch-sensitive').getByRole('checkbox')

async function openMemory(page: Page): Promise<void> {
  await openProfile(page)
  await page.getByTestId('row-memory').click()
  await expect(page).toHaveURL(/\/profile\/memory$/)
}

async function openSheet(page: Page): Promise<void> {
  await page.getByTestId('memory-open').click()
  await expect(sheet(page)).toBeVisible()
  if (await page.getByTestId('memory-reveal').getByText('Показать').count()) await page.getByTestId('memory-reveal').click()
}

async function sheetText(page: Page): Promise<string> {
  await openMemory(page)
  await openSheet(page)
  const text = (await sheet(page).innerText()).toLowerCase()
  await page.keyboard.press('Escape')
  return text
}

/** Waits until the notes of the person satisfy the check: the agent makes them a moment after the words. */
async function eventually(page: Page, check: (text: string) => boolean, what: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    text = await sheetText(page)
    if (check(text)) return text
    await page.waitForTimeout(4_000)
  }
  throw new Error(`не дождались: ${what}\n${text}`)
}

/** Starts a conversation with the typed words, waits for the model's reply, ends it, returns home. */
async function talkAndEnd(page: Page, words: string, shotName?: string, shoot?: (page: Page, name: string) => Promise<void>): Promise<string> {
  await goTo(page, 'Новый разговор')
  await homeInput(page).fill(words)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  // The first assistant line is the fixed greeting; the model's answer to the words is the second.
  await expect.poll(() => messages(page, 'assistant').count(), { timeout: 90_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 90_000 })
  const reply = (await messages(page, 'assistant').last().innerText()).toLowerCase()
  await expect(dialogInput(page)).toBeVisible()
  if (shotName && shoot) await shoot(page, shotName) // the conversation with the answer of the model, before it is ended
  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  return reply
}

test('память на настоящем агенте: слова → заметки от модели → запретное не сохраняется → «Убери тему» → следующий разговор знает человека', async ({
  page,
  shot,
}) => {
  test.setTimeout(900_000)
  await openWebApp(page)
  await startAnonymously(page)

  // ── on, through the consent sheet ───────────────────────────────────────────────────────────
  await openMemory(page)
  await memorySwitch(page).click()
  await shot(page, 'real-memory-consent')
  await modalButton(page, 'Включить память').click()
  await expect(memorySwitch(page)).toBeChecked()

  // ── words → notes made by the model (the final pass runs when the conversation ends) ───────
  await talkAndEnd(page, 'Меня зовут Алекс, я работаю в продажах. Давай на ты.')
  const text = await eventually(page, (t) => t.includes('алекс') && t.includes('продаж'), 'заметки об Алексе и продажах')
  expect(text).toContain('алекс')
  await openMemory(page)
  await openSheet(page)
  await shot(page, 'real-memory-sheet-notes')
  await page.keyboard.press('Escape')

  // ── what is forbidden never becomes a note, whatever the model did ──────────────────────────
  await talkAndEnd(page, 'Мне поставили диагноз депрессия, я пью антидепрессанты. Мой телефон +7 999 123 45 67.')
  await page.waitForTimeout(40_000)
  const afterForbidden = await sheetText(page)
  expect(afterForbidden).not.toMatch(/депресс|антидепресс|999|123 45/)
  await openMemory(page)
  await openSheet(page)
  await shot(page, 'real-memory-forbidden-not-saved')
  await page.keyboard.press('Escape')

  // ── sensitive: only with the switch ─────────────────────────────────────────────────────────
  await openMemory(page)
  await sensitiveSwitch(page).click()
  await expect(sensitiveSwitch(page)).toBeChecked()
  await shot(page, 'real-memory-sensitive-on')
  await talkAndEnd(page, 'Последние недели я плохо сплю, ворочаюсь по ночам.')
  await eventually(page, (t) => t.includes('самочувствие'), 'заметка о самочувствии при включённом «чувствительном»')
  await openMemory(page)
  await openSheet(page)
  await shot(page, 'real-memory-sensitive-note')
  await page.keyboard.press('Escape')
  await openMemory(page)
  await sensitiveSwitch(page).click()
  await expect(sensitiveSwitch(page)).not.toBeChecked()
  expect(await sheetText(page)).not.toContain('самочувствие')

  // ── "Убери тему…": the model finds the note, the code carries it out ────────────────────────
  await openMemory(page)
  await openSheet(page)
  await sheet(page).getByTestId('memory-instruction-input').fill('Забудь про мою работу в продажах')
  await sheet(page).getByTestId('memory-instruction-send').click()
  await expect(sheet(page).getByTestId('memory-instruction-result')).toContainText(/Удалено|Изменено/, { timeout: 60_000 })
  await shot(page, 'real-memory-instruction')
  await page.keyboard.press('Escape')
  expect(await sheetText(page)).not.toContain('продаж')

  // ── the next conversation knows the person: the memory block reaches the model ──────────────
  const reply = await talkAndEnd(page, 'Скажи, как меня зовут?', 'real-memory-next-conversation', shot)
  expect(reply).toContain('алекс')
})
