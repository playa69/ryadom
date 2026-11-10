import type { Locator, Page } from '@playwright/test'
import {
  button,
  closeSheet,
  openApp,
  openJournal,
  registerAndConfirm,
  sheetButton,
  uniqueEmail,
} from '../support/app'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { expectSpoken, playedBy, setAgentSpeech, spokenBy } from '../support/speech'

/**
 * The conversation. The agent is a mock here, so what is checked is not the content of the
 * replies but that the whole chain is alive: app → WebSocket gateway → agent → back to the
 * screen, the conversation lands in the journal, and crisis words raise the help lines by
 * themselves.
 *
 * One scenario, for the same reason as the account path: sign-in is rate limited.
 */
const DRAFT_PLACEHOLDER = 'Напиши, что происходит'

test('разговор: приветствие, ответ, кризис, журнал', async ({ page, shot }) => {
  const email = uniqueEmail('dialog')
  await clearMailbox()
  await openApp(page)
  await registerAndConfirm(page, email)

  // No modes to pick: one conversation (`openspec/changes/merge-first-screen-into-home`).
  await expect(page.locator('.page-current').getByText('Выговориться')).toHaveCount(0)
  await shot(page, 'dialog-home')

  // ── conversation: voice first ────────────────────────────────────────────
  await button(page, 'Поговорить').click()
  // The conversation opens on the voice screen and listens by itself (the fake microphone).
  const stop = page.getByRole('button', { name: 'Остановить запись' })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const caption = page.getByTestId('voice-caption')
  // The greeting from the dialog start is on screen before the first word.
  await expect(caption).not.toBeEmpty({ timeout: 30_000 })
  const greeting = ((await caption.textContent()) ?? '').trim()
  // The agent says the greeting itself: its audio streamed in and played, and the app's own voice stayed out
  // of it. The stop button above appears only after that, because listening waits for the greeting.
  const greetingFrames = await playedBy(page)
  expect(greetingFrames, 'приветствие агента сыграно').toBeGreaterThan(5)
  expect(await spokenBy(page), 'своего голоса приложение не включало').toEqual([])
  await shot(page, 'dialog-voice')

  // A turn by voice: the mock answers an utterance once the frames pause.
  await stop.click()
  await expect(page.getByRole('button', { name: 'Говорить', exact: true })).toBeVisible()
  // The reply streams in and the sphere settles: the hint is back to "tap and speak" and the greeting
  // under the sphere has been replaced.
  await expect(page.getByRole('status').filter({ hasText: 'Нажми на шар и говори' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(caption).not.toBeEmpty()
  await expect(caption).not.toHaveText(greeting)
  // The reply is voiced by the agent as well: more of its audio played, and the app's own voice stayed out.
  // Polled: a real speech provider needs a moment to start, the mock does not.
  await expect.poll(() => playedBy(page), { message: 'ответ агента сыгран' }).toBeGreaterThan(greetingFrames)
  expect(await spokenBy(page)).toEqual([])
  await shot(page, 'dialog-voice-reply')

  // ── text: the second way, one tap away ───────────────────────────────────
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder(DRAFT_PLACEHOLDER)
  await expect(input).toBeVisible()
  // The feed holds the greeting, the voice turn and the reply to it.
  await expect(page.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('.message-sent')).toHaveCount(1)
  await shot(page, 'dialog-start')

  await input.fill('Сегодня было очень тяжело')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.locator('.message-sent')).toHaveCount(2, { timeout: 20_000 })
  // The mock replies one word at a time, so wait for the next reply in full.
  await expect(page.locator('.message-received')).toHaveCount(3, { timeout: 30_000 })
  // Nobody speaks to someone who is reading: the text is silent, the agent's voice and the app's own.
  expect(await spokenBy(page)).toEqual([])
  await shot(page, 'dialog-reply')

  // ── crisis protocol ──────────────────────────────────────────────────────
  // A word from the mock's list: a real agent decides this itself, the frame is the same.
  await input.fill('не хочу жить')
  await page.getByRole('button', { name: 'Отправить' }).click()
  // The help lines appear on their own instead of waiting for the person to press SOS.
  await expect(page.getByText('Если сейчас тяжело')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: /112/ })).toBeVisible()
  await shot(page, 'dialog-safety')
  await closeSheet(page)

  // ── ending and journal ───────────────────────────────────────────────────
  // The voice button on the right of the empty input box goes back to the sphere, which listens
  // again; ending from there switches the microphone off.
  await page.getByRole('button', { name: 'Говорить голосом' }).click()
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Завершить разговор' }).click()
  await expect(page.getByText('Что забираешь с собой?')).toBeVisible()
  await page.getByTestId('takeaway-input').fill('Стало чуть легче')
  await shot(page, 'dialog-end')
  await sheetButton(page, 'Завершить').click()

  // The summary is shown in a Framework7 system dialog; while it is open the tabs are unreachable.
  const done = page.locator('.dialog.modal-in')
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done).toContainText('Забираешь с собой')
  await shot(page, 'dialog-summary')
  await done.getByText('ОК').click()

  await openJournal(page)
  await expect(page.getByTestId('journal-item').first()).toBeVisible({ timeout: 30_000 })
  await shot(page, 'journal')
})

/**
 * An agent whose speech is down sends text only. The sphere still reads the greeting with the app's own
 * voice (listening waits for it), but never a reply: a platform voice stepping in over a slow agent made
 * replies sound twice.
 */
test('агент без озвучки: шар читает приветствие, но не ответ', async ({ page }) => {
  await setAgentSpeech('none')
  try {
    const email = uniqueEmail('dialog-own-voice')
    await clearMailbox()
    await openApp(page)
    await registerAndConfirm(page, email)

    await button(page, 'Поговорить').click()
    const stop = page.getByRole('button', { name: 'Остановить запись' })
    await expect(stop).toBeVisible({ timeout: 30_000 })
    const caption = page.getByTestId('voice-caption')
    await expect(caption).not.toBeEmpty({ timeout: 30_000 })
    const greeting = ((await caption.textContent()) ?? '').trim()
    await expectSpoken(page, greeting)
    expect(await playedBy(page), 'агент ничего не присылал').toBe(0)

    await stop.click()
    await expect(page.getByRole('status').filter({ hasText: 'Нажми на шар и говори' })).toBeVisible({
      timeout: 30_000,
    })
    const reply = ((await caption.textContent()) ?? '').trim()
    expect(reply).not.toBe(greeting)
    // The old fallback stepped in after 0.9 s: wait well past that before checking that nothing was said.
    await page.waitForTimeout(2_000)
    await expectSpoken(page, greeting)
  } finally {
    await setAgentSpeech('auto')
  }
})


/**
 * The red and yellow levels of the crisis branch, driven by the mock's script («кризис-красный»,
 * «кризис-жёлтый»). Specs: openspec/changes/extend-crisis-branch, «Скрипт красного уровня» and «Жёлтый уровень».
 */
async function openTextDialog(page: Page, name: string) {
  await clearMailbox()
  await openApp(page)
  await registerAndConfirm(page, uniqueEmail(name))
  await button(page, 'Поговорить').click()
  const stop = page.getByRole('button', { name: 'Остановить запись' })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  // Let the mock answer the voice turn first, or its reply lands in the middle of the script.
  await page.waitForTimeout(1200)
  await stop.click()
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder(DRAFT_PLACEHOLDER)
  await expect(input).toBeVisible()
  await expect(page.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('.rd-typing')).toHaveCount(0, { timeout: 30_000 })
  return input
}

async function say(page: Page, input: Locator, text: string) {
  await input.fill(text)
  await page.getByRole('button', { name: 'Отправить' }).click()
}

test('красный уровень: лист, вопрос о безопасности, 112, возврат из звонка, закреплённая кнопка', async ({ page, shot }) => {
  test.setTimeout(150_000)
  const input = await openTextDialog(page, 'crisis-red')
  // A tel: link has nowhere to go in a headless browser; the app still sees the tap.
  await page.evaluate(() => document.addEventListener('click', (event) => (event.target as Element).closest('a[href^="tel:"]') && event.preventDefault()))

  await say(page, input, 'кризис-красный')
  // Step 1: the sheet of the script, with the way out always in view.
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByText('Сейчас важно поговорить с живым человеком')).toBeVisible({ timeout: 30_000 })
  await expect(sheet.getByTestId('sos-call-now')).toHaveAttribute('href', 'tel:84959895050')
  await expect(sheet.getByTestId('sos-call-now')).toContainText('Позвонить сейчас')
  await expect(sheet.getByTestId('sos-call-112')).toContainText('112 — если есть опасность для жизни')
  await expect(sheet.getByTestId('sos-safe-link')).toHaveText('Я в безопасности, давай продолжим')
  await expect(sheet.getByRole('link', { name: /Московская/ })).toHaveAttribute('href', 'tel:8495051')
  await expect(sheetButton(page, 'Закрыть')).toBeVisible()
  await shot(page, 'crisis-help')

  // Step 2: the question, in the open sheet.
  await expect(sheet.getByTestId('safe-answers')).toBeVisible({ timeout: 30_000 })
  await expect(sheet.getByTestId('safe-answers').locator('.button')).toHaveText(['Да', 'Нет', 'Не знаю'])
  await shot(page, 'crisis-ask-safe')

  // Step 2a: «Не знаю» gives the large 112 with the lines below it.
  await sheet.getByTestId('safe-answers').locator('.button', { hasText: 'Не знаю' }).click()
  await expect(sheet.getByTestId('sos-call-112-big')).toHaveText('112')
  await expect(sheet.getByTestId('safe-answers')).toHaveCount(0)
  await expect(sheet.getByRole('link', { name: /Московская/ })).toBeVisible()
  await shot(page, 'crisis-112')

  // Step 4: a tap on a line and the way back to the app: the agent asks how it went.
  await sheet.getByTestId('sos-call-112-big').click()
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  await closeSheet(page)
  await expect(page.locator('.message-received').last()).toContainText('Получилось поговорить?', { timeout: 30_000 })

  // Step 2b: the link on step 1 is the answer «Да»; the sheet closes and the call button stays above the conversation.
  await say(page, input, 'кризис-красный')
  await expect(sheet.getByTestId('sos-safe-link')).toBeVisible({ timeout: 30_000 })
  await sheet.getByTestId('sos-safe-link').click()
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  await expect(page.locator('.message-sent').last()).toContainText('Да, я в безопасности')
  const pinned = page.getByTestId('crisis-pinned-call')
  await expect(pinned).toBeVisible({ timeout: 30_000 })
  await expect(pinned).toHaveAttribute('href', 'tel:84959895050')
  await shot(page, 'crisis-pinned')

  // The sphere is calm for the whole session: steady light, no pulsing.
  await page.getByRole('button', { name: 'Говорить голосом' }).click()
  await expect(page.locator('.rd-orb[data-calm]')).toHaveCount(1)
  await expect(pinned).toBeVisible()
})

test('жёлтый уровень: вопрос без листа, ответ «Нет» даёт плашку «Нужна помощь?»', async ({ page, shot }) => {
  test.setTimeout(150_000)
  const input = await openTextDialog(page, 'crisis-yellow')

  await say(page, input, 'кризис-жёлтый')
  await expect(page.locator('.message-received').last()).toContainText('мысли', { timeout: 30_000 })
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  await expect(page.getByTestId('crisis-banner')).toHaveCount(0)

  await say(page, input, 'Нет')
  const banner = page.getByTestId('crisis-banner')
  await expect(banner).toHaveText('Нужна помощь?', { timeout: 30_000 })
  await expect(page.locator('.sheet-modal.modal-in')).toHaveCount(0)
  await shot(page, 'crisis-banner')

  // The banner opens the sheet with the default text and the bundled lines.
  await banner.click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByText('Если сейчас тяжело')).toBeVisible()
  await expect(sheet.getByRole('link', { name: /112/ })).toBeVisible()
  await expect(sheet.getByRole('link', { name: /Московская/ })).toHaveAttribute('href', 'tel:8495051')
})
