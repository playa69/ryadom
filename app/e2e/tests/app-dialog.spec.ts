import {
  button,
  closeSheet,
  openApp,
  openTab,
  registerAndConfirm,
  sheetButton,
  startAnonymously,
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

  await expect(page.getByRole('button', { name: 'Выговориться' })).toBeVisible()
  await shot(page, 'dialog-modes')

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

  await openTab(page, 'Журнал')
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

/** The agent mock's recap (dev/agent-mock): the real one is written by a model from the conversation. */
const RECAP = 'Говорили о том, что сейчас на душе. Пришли к тому, что стоит вернуться к этому завтра.'
/** Over the 40 characters below which the agent gives no recap. */
const LONG_MESSAGE = 'С братом поссорились из-за денег, и теперь непонятно, как начать разговор'

test('итог разговора сам встаёт в «что забираешь с собой», и его можно поправить', async ({ page, shot }) => {
  test.setTimeout(120_000)
  await openApp(page)
  // The first screen says what this is and what happens to the words, before anything is accepted.
  await expect(page.getByText('поможет разобраться в мыслях')).toBeVisible()
  await expect(page.getByText(/Голос не записывается, разговоры хранятся в России/)).toBeVisible()
  await startAnonymously(page)

  await button(page, 'Поговорить').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder(DRAFT_PLACEHOLDER)
  await expect(input).toBeVisible()
  await input.fill(LONG_MESSAGE)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.locator('.message-sent').last()).toContainText(LONG_MESSAGE, { timeout: 20_000 })
  await expect(page.locator('.message-received')).toHaveCount(3, { timeout: 30_000 })

  await page.locator('.page-current').getByRole('button', { name: 'Завершить разговор' }).click()
  const takeaway = page.getByTestId('takeaway-input')
  await expect(takeaway).toHaveValue(RECAP, { timeout: 15_000 })
  await expect(page.getByTestId('takeaway-hint')).toContainText('Это итог разговора')
  await shot(page, 'dialog-recap')

  // The person's edit is what is kept: the recap itself is stored nowhere.
  await takeaway.fill('Напишу брату завтра утром')
  await sheetButton(page, 'Завершить').click()
  const done = page.locator('.dialog.modal-in')
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done).toContainText('Напишу брату завтра утром')
})
