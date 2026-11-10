import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import {
  dialogInput,
  expectNoHorizontalOverflow,
  homeInput,
  messages,
  modal,
  openWebApp,
  registerAndConfirm,
  uniqueEmail,
} from '../support/web'
import type { Page } from '@playwright/test'

/**
 * The crisis branch of the conversation (PROTEUS-279, openspec crisis-safety): the red script (the sheet with "Call
 * now", the pinned call button, the safety question with quick answers, 112) and the yellow one (a direct question,
 * the banner after "no"). The agent is a mock that speaks the real agent's frames; what is checked is the screen.
 */
const SHEET_TITLE = 'Сейчас важно поговорить с живым человеком'
const CALL_HREF = 'tel:84959895050'

async function begin(page: Page, text: string): Promise<void> {
  await openWebApp(page, '/home')
  await homeInput(page).fill(text)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\//, { timeout: 30_000 })
}

async function say(page: Page, text: string): Promise<void> {
  const input = dialogInput(page)
  await input.fill(text)
  await input.press('Enter')
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
}

test('красный уровень: лист «Позвонить сейчас», закреплённая кнопка, вопрос о безопасности, 112', async ({ page, shot }) => {
  test.setTimeout(150_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-crisis'))
  await begin(page, 'я больше не хочу жить')

  // Step 1: the sheet opens by itself, with the call button, 112 and the way back.
  const sheet = modal(page)
  await expect(sheet.getByRole('heading', { name: SHEET_TITLE })).toBeVisible({ timeout: 30_000 })
  const callNow = sheet.getByTestId('sos-call-now')
  await expect(callNow).toHaveAttribute('href', CALL_HREF)
  await expect(sheet.getByTestId('sos-112')).toHaveAttribute('href', 'tel:112')
  await expect(sheet.getByTestId('sos-safe')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-crisis-sheet')

  // "I am safe, let's go on": the sheet closes, the call button stays pinned above the conversation.
  await sheet.getByTestId('sos-safe').click()
  await expect(modal(page)).toHaveCount(0)
  await settled(page)
  const pinned = page.getByTestId('crisis-call')
  await expect(pinned).toHaveAttribute('href', CALL_HREF)
  await shot(page, 'web-crisis-pinned')

  // Step 2: the next reply of the person gets the safety question with quick answers.
  await say(page, 'не знаю, что сказать')
  await expect(page.getByTestId('crisis-ask').getByRole('button', { name: 'Не знаю' })).toBeVisible({ timeout: 30_000 })
  await settled(page)
  await shot(page, 'web-crisis-check')

  // Step 2a: "I don't know" gives 112 and opens the sheet again; the pinned button does not go away.
  await page.getByTestId('crisis-ask').getByRole('button', { name: 'Не знаю' }).click()
  await expect(modal(page).getByRole('heading', { name: SHEET_TITLE })).toBeVisible({ timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toContainText('позвони сейчас 112', { timeout: 30_000 })
  await modal(page).getByRole('button', { name: 'Закрыть' }).click()
  await expect(page.getByTestId('crisis-call')).toBeVisible()
  await expect(page.getByTestId('crisis-ask')).toHaveCount(0)
})

test('жёлтый уровень: прямой вопрос; «нет» оставляет плашку «Нужна помощь?»', async ({ page, shot }) => {
  test.setTimeout(150_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-yellow'))
  await begin(page, 'всё бессмысленно')

  const ask = page.getByTestId('crisis-ask')
  await expect(ask.getByRole('button', { name: 'Да' })).toBeVisible({ timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toContainText('У тебя бывают такие мысли?', { timeout: 30_000 })
  // The sheet does not open on the yellow level.
  await expect(modal(page)).toHaveCount(0)
  await settled(page)
  await shot(page, 'web-crisis-yellow-ask')

  await ask.getByRole('button', { name: 'Нет' }).click()
  await expect(page.getByTestId('crisis-banner')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('crisis-call')).toHaveCount(0)
  await settled(page)
  await shot(page, 'web-crisis-yellow-banner')
  await page.getByTestId('crisis-banner').click()
  await expect(modal(page).getByRole('heading', { name: 'Если сейчас тяжело' })).toBeVisible()
})
