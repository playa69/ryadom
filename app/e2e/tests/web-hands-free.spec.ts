import { messages, openWebApp, registerAndConfirm, talkButton, uniqueEmail } from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { playedBy, speakAndTime, speakIntoMic, spokenBy } from '../support/speech'

// Hands-free, with a microphone the test speaks into (support/speech.ts, installMicrophone).
test.use({ handsFree: true, permissions: ['microphone'] })

/**
 * Hands-free voice against the agent mock: after one tap on "Поговорить" the conversation goes on by
 * voice alone. Speech starts a turn and a second of silence ends it, talking over the agent silences it
 * at once and is heard as a new turn, a tap only pauses the microphone, and a hidden tab closes it.
 */
test('голос без рук в вебе: реплики без касаний, перебивание голосом, пауза', async ({ page }) => {
  test.setTimeout(150_000)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-hands-free'))

  await talkButton(page).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
  const mic = page.getByTestId('dialog-mic')
  const hint = page.getByTestId('voice-hint')
  const caption = page.getByTestId('voice-caption')
  // After the greeting the microphone opens by itself and stays open.
  await expect(mic).toHaveAccessibleName('Поставить микрофон на паузу', { timeout: 30_000 })
  await expect(hint).toHaveText('Говори, я слушаю')
  const greeting = ((await caption.textContent()) ?? '').trim()
  const greetingFrames = await playedBy(page)

  // ── a turn without a tap: speech starts it, a second of silence ends it ──
  await speakIntoMic(page, true)
  await expect(hint).toHaveText('Слушаю…', { timeout: 5_000 })
  await page.waitForTimeout(1500)
  await speakIntoMic(page, false)
  await expect(caption).not.toHaveText(greeting, { timeout: 30_000 })
  // The agent answers aloud, and the hint says it can be talked over.
  await expect(hint).toHaveText('Просто начни говорить, чтобы перебить', { timeout: 30_000 })
  await expect.poll(() => playedBy(page), { message: 'ответ агента звучит' }).toBeGreaterThan(greetingFrames)
  const firstReply = ((await caption.textContent()) ?? '').trim()

  // ── talking over the agent ───────────────────────────────────────────────
  // The 300 ms bound is the detector's (unit tests); here a slow CI browser gets some slack.
  const tookMs = await speakAndTime(page, 'Слушаю…')
  expect(tookMs, 'шар замолкает, как только человек заговорил').toBeLessThan(600)
  const played = await playedBy(page)
  await page.waitForTimeout(800)
  expect(await playedBy(page), 'после перебивания голос агента больше не звучит').toBe(played)
  await speakIntoMic(page, false)
  // The turn that interrupted is heard whole and answered.
  await expect(caption).not.toHaveText(firstReply, { timeout: 30_000 })
  await expect(hint).toHaveText(/Просто начни говорить|Говори, я слушаю/, { timeout: 30_000 })

  // ── a tap pauses the microphone, and nothing is heard until the next one ──
  await mic.click()
  await expect(mic).toHaveAccessibleName('Включить микрофон')
  await expect(hint).toHaveText('Микрофон на паузе')
  await speakIntoMic(page, true)
  await page.waitForTimeout(800)
  await expect(hint).not.toHaveText('Слушаю…')
  await speakIntoMic(page, false)
  await mic.click()
  await expect(mic).toHaveAccessibleName('Поставить микрофон на паузу', { timeout: 10_000 })

  // ── a hidden tab closes the microphone ───────────────────────────────────
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(mic).toHaveAccessibleName('Включить микрофон')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  // Both turns are in the feed as the person's own lines, and every reply was the agent's own voice.
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const user = messages(page, 'user')
  await expect(user).toHaveCount(2, { timeout: 30_000 })
  await expect(user.first()).toContainText('голосовая реплика')
  expect(await spokenBy(page)).toEqual([])
  expect(failures, 'ошибки страницы').toEqual([])
})
