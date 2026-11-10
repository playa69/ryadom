import type { Page } from '@playwright/test'
import {
  closeSidebar,
  dialogInput,
  expectHistoryCount,
  expectNoHorizontalOverflow,
  expectSingleSos,
  goTo,
  historyItems,
  homeInput,
  messages,
  modal,
  modalButton,
  openMark,
  openSidebar,
  openWebApp,
  pageTitle,
  registerAndConfirm,
  talkButton,
  uniqueEmail,
  watchCsp,
} from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { expectSpoken, playedBy, setAgentSpeech, spokenBy } from '../support/speech'

// A headless browser has no microphone of its own: the fake device plays a tone, and the fake prompt
// answers the permission question (the desktop project grants nothing by itself).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

/**
 * The conversation in the web app, the counterpart of app-dialog.spec.ts. The agent is a mock, so
 * what is checked is not the content of the replies but that the whole chain is alive: page →
 * WebSocket gateway → agent → back to the screen, crisis words raise the help lines by
 * themselves, and the finished conversation lands in the history with its transcript.
 *
 * The layout is a chat app's: the conversation is a centred column under a header that holds the
 * way to end it, the input box is docked at the bottom, and the history lives in the sidebar. The
 * first scenario runs at both project sizes, so every step holds with a column and with a drawer.
 */
const DRAFT_PLACEHOLDER = 'Напиши, что происходит'
const FIRST_MESSAGE = 'Сегодня было очень тяжело'
const TAKEAWAY = 'Стало чуть легче'

test('разговор в вебе: приветствие, ответ, кризис, завершение, журнал', async ({ page, shot }) => {
  test.setTimeout(150_000)
  const violations = await watchCsp(page)
  const email = uniqueEmail('web-dialog')
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, email)

  // ── home ─────────────────────────────────────────────────────────────────
  // No modes to pick: one conversation (`openspec/changes/merge-first-screen-into-home`).
  await expect(page.getByRole('button', { name: /Выговориться|Поболтать/ })).toHaveCount(0)
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-dialog-modes')

  // ── conversation, started with nothing typed: it opens on the voice ──────
  await talkButton(page).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
  // The sphere listens by itself (the fake microphone), and the greeting is under it.
  const stop = page.getByRole('button', { name: 'Остановить запись' })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const caption = page.getByTestId('voice-caption')
  await expect(caption).not.toBeEmpty({ timeout: 30_000 })
  const greeting = ((await caption.textContent()) ?? '').trim()
  // The agent says the greeting itself: its audio streamed in and played, and the app's own voice stayed out
  // of it. The stop button above appears only after that, because listening waits for the greeting.
  const greetingFrames = await playedBy(page)
  expect(greetingFrames, 'приветствие агента сыграно').toBeGreaterThan(5)
  expect(await spokenBy(page), 'своего голоса приложение не включало').toEqual([])
  await expect(pageTitle(page)).toHaveText('Разговор')
  await expect(page).toHaveTitle('Разговор — Рядом')
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  // "End" is among the voice controls here, not in the header, and there is still just one of it.
  await expect(page.getByRole('button', { name: 'Завершить разговор', exact: true })).toHaveCount(1)
  await expect(page.getByTestId('dialog-input')).toHaveCount(0)
  await shot(page, 'web-dialog-voice')

  // A turn by voice: the mock answers an utterance once the frames pause, and its reply replaces the
  // greeting under the sphere.
  await page.waitForTimeout(1200)
  await stop.click()
  await expect(caption).not.toHaveText(greeting, { timeout: 30_000 })
  await expect(caption).not.toBeEmpty()
  // The reply is voiced by the agent as well: more of its audio played, and the app's own voice stayed out.
  await expect(caption).toHaveText(/[.!?…]$/, { timeout: 30_000 })
  await expect.poll(() => playedBy(page), { message: 'ответ агента сыгран' }).toBeGreaterThan(greetingFrames)
  expect(await spokenBy(page)).toEqual([])
  await shot(page, 'web-dialog-voice-reply')

  // ── text: the second way, one tap away ───────────────────────────────────
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder(DRAFT_PLACEHOLDER)
  await expect(input).toBeVisible({ timeout: 30_000 })

  const assistant = messages(page, 'assistant')
  const user = messages(page, 'user')
  // The feed holds the greeting, the line the mock heard and the reply to it.
  await expect(user).toHaveCount(1, { timeout: 30_000 })
  await expect(user.first()).toContainText('голосовая реплика')
  await expect(assistant).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  // Streaming text is not in a live region; this one gets each reply once, when it is complete.
  const live = page.getByTestId('dialog-live')
  await expect(live).not.toBeEmpty()
  const previousReply = (await live.textContent()) ?? ''

  // The page is a chat: "end" sits in the header beside SOS, there is no way back to a screen above,
  // and the input box is docked at the bottom of the window under a reading column.
  const viewport = page.viewportSize()!
  const end = page.getByRole('button', { name: 'Завершить разговор', exact: true })
  await expect(end).toBeVisible()
  expect((await end.boundingBox())!.y, 'завершить — в шапке').toBeLessThan(70)
  await expect(page.getByTestId('dialog-back')).toHaveCount(0)
  const dock = (await input.boundingBox())!
  expect(dock.y + dock.height, 'поле ввода внизу окна').toBeGreaterThanOrEqual(viewport.height - 80)
  expect(dock.y + dock.height, 'поле ввода в окне').toBeLessThanOrEqual(viewport.height)
  expect(
    (await page.getByTestId('dialog-feed').boundingBox())!.width,
    'колонка чтения не шире 768px',
  ).toBeLessThanOrEqual(770)
  await shot(page, 'web-dialog-start')

  await input.fill(FIRST_MESSAGE)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(user).toHaveCount(2, { timeout: 20_000 })
  await expect(user.nth(1)).toContainText(FIRST_MESSAGE)
  await expect(input).toHaveValue('')
  // The mock replies one word at a time: the reply is complete once the live region has it.
  await expect(assistant).toHaveCount(3, { timeout: 30_000 })
  await expect(live).not.toHaveText(previousReply, { timeout: 30_000 })
  await expect(assistant.nth(2)).toContainText((await live.textContent()) ?? '')
  // Nobody speaks to someone who is reading: the text is silent, the agent's voice and the app's own.
  expect(await spokenBy(page)).toEqual([])
  // A chat's alignment: the person's own lines sit on the right, the companion's start on the left.
  const feed = (await page.getByTestId('dialog-feed').boundingBox())!
  const mine = (await user.nth(1).locator('p').boundingBox())!
  const theirs = (await assistant.nth(2).boundingBox())!
  expect(mine.x + mine.width, 'свои реплики справа').toBeGreaterThanOrEqual(feed.x + feed.width - 8)
  expect(theirs.x, 'ответ слева').toBeLessThanOrEqual(feed.x + 8)
  await shot(page, 'web-dialog-reply')

  // ── crisis protocol ──────────────────────────────────────────────────────
  // A word from the mock's list: a real agent decides this itself, the frame is the same. Enter
  // sends, as in a messenger.
  await input.fill('не хочу жить')
  await input.press('Enter')
  // The help lines appear on their own instead of waiting for the person to press SOS.
  await expect(modal(page).getByRole('heading', { name: 'Если сейчас тяжело' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(modal(page).getByRole('link', { name: /112/ })).toBeVisible()
  await shot(page, 'web-dialog-safety')
  await modalButton(page, 'Закрыть').click()
  await expect(modal(page)).toHaveCount(0)
  // Ending in the middle of a reply would only test the fallback timer.
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })

  // ── ending ───────────────────────────────────────────────────────────────
  await end.click()
  await expect(modal(page).getByRole('heading', { name: 'Что забираешь с собой?' })).toBeVisible()
  await page.getByTestId('takeaway-input').fill(TAKEAWAY)
  const tension = modal(page).getByRole('button', { name: '4', exact: true })
  await tension.click()
  await expect(tension).toHaveAttribute('aria-pressed', 'true')
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-dialog-end')
  await modalButton(page, 'Завершить').click()

  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByTestId('alert-text')).toContainText('Забираешь с собой')
  await shot(page, 'web-dialog-summary')
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)

  // ── the finished conversation is in the sidebar ──────────────────────────
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(1)
  await expect(historyItems(page).first()).toHaveText(TAKEAWAY)
  await expect(openMark(page), 'завершённый разговор без отметки «не завершён»').toHaveCount(0)
  await closeSidebar(page)

  // ── history: all conversations, then one of them ─────────────────────────
  await goTo(page, 'Все разговоры')
  await expect(page).toHaveURL(/\/diary\/journal$/)
  await expect(page).toHaveTitle('Дневник — Рядом')
  await expect(pageTitle(page)).toHaveText('Дневник')
  const row = page.getByTestId('journal-item').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('journal-list').getByRole('heading', { level: 2 })).toHaveText(['Сегодня'])
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-journal')

  // A past conversation is a page of its own at every width: no pane beside the list.
  await row.click()
  await expect(page).toHaveURL(/\/diary\/journal\/[^/]+$/)
  await expect(page).toHaveTitle('Разговор — Рядом')
  // The header holds the h1: the conversation's title, with the way back beside it.
  await expect(pageTitle(page)).toHaveText(TAKEAWAY, { timeout: 20_000 })
  await expect(page.getByTestId('journal-summary')).toBeVisible({ timeout: 20_000 })
  const said = page
    .getByTestId('journal-messages')
    .getByTestId('dialog-message')
    .filter({ hasText: FIRST_MESSAGE })
  await expect(said).toHaveCount(1)
  await expect(said).toHaveAttribute('data-role', 'user')
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-journal-entry')

  // The sidebar marks the conversation that is open.
  await openSidebar(page)
  await expect(historyItems(page).first()).toHaveAttribute('aria-current', 'page')
  await closeSidebar(page)

  await page.getByRole('main').getByRole('link', { name: 'Все разговоры', exact: true }).click()
  await expect(page).toHaveURL(/\/diary\/journal$/)
  await row.click()
  await expect(page).toHaveURL(/\/diary\/journal\/[^/]+$/)
  // Carrying on from a finished conversation is a new one.
  await page.getByTestId('journal-continue').click()
  await expect(page).toHaveURL(/\/home$/)

  // The whole run was one page load: nothing on the way was blocked by the security policy, which
  // includes the WebSocket to the API origin.
  expect(await violations(), 'нарушения политики безопасности').toEqual([])
})

/**
 * Home is the empty state of a chat: what is typed in its box becomes the first message of the
 * conversation, once. With text the button says "Отправить", with an empty box "Поговорить". A
 * reload brings the same conversation back from the server, and "new conversation" while one is
 * still open returns to it instead of starting a second.
 */
test('с главной: набранный текст — первое сообщение, ответ приходит, повторного старта нет', async ({
  page,
  shot,
}) => {
  test.setTimeout(150_000)
  const violations = await watchCsp(page)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-first'))

  const send = page.getByTestId('home-talk')
  await expect(homeInput(page)).toHaveAttribute('placeholder', 'Напиши или скажи, что на душе…')
  await expect(send).toHaveAccessibleName('Поговорить')
  await expect(page.getByTestId('home-mic')).toHaveAccessibleName('Говорить')
  await homeInput(page).fill(FIRST_MESSAGE)
  await expect(send).toHaveAccessibleName('Отправить')
  await shot(page, 'web-home-typed')
  await homeInput(page).press('Enter')

  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  const dialogUrl = page.url()
  const user = messages(page, 'user')
  const assistant = messages(page, 'assistant')
  // The text arrives as the person's first message, once, and the greeting stays above it.
  await expect(user).toHaveCount(1, { timeout: 30_000 })
  await expect(user.first()).toContainText(FIRST_MESSAGE)
  await expect(assistant).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(user, 'сообщение не ушло дважды').toHaveCount(1)
  await expect(dialogInput(page)).toHaveValue('')
  expect(await spokenBy(page), 'в тексте шар молчит').toEqual([])
  expect(await playedBy(page), 'и агент в тексте не звучит').toBe(0)
  const roles = await page
    .getByTestId('dialog-feed')
    .getByTestId('dialog-message')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-role')))
  expect(roles).toEqual(['assistant', 'user', 'assistant'])
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-dialog-from-home')

  // The conversation is already in the sidebar, marked as not finished, and it is the open page.
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(1)
  await expect(openMark(page)).toHaveCount(1)
  await expect(historyItems(page).first()).toHaveAttribute('href', /\/dialog\/[^/]+$/)
  await expect(historyItems(page).first()).toHaveAttribute('aria-current', 'page')
  await closeSidebar(page)

  // A reload restores the feed from the server: nothing lost, nothing twice.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page).toHaveURL(dialogUrl)
  await expect(user).toHaveCount(1, { timeout: 30_000 })
  await expect(user.first()).toContainText(FIRST_MESSAGE)
  await expect(assistant.last()).toBeVisible()
  await expect(dialogInput(page)).toBeVisible()
  // The live region holds the latest reply as plain text (a message in the feed also carries a hidden "Рядом:").
  await expect(page.getByTestId('dialog-live')).not.toBeEmpty()
  const lastReply = ((await page.getByTestId('dialog-live').textContent()) ?? '').trim()

  // "New conversation" while this one is open: the same conversation, not a second one.
  await goTo(page, 'Новый разговор')
  await expect(page).toHaveURL(/\/home$/)
  await expect(talkButton(page)).toBeVisible()
  await talkButton(page).click()
  // Something was said in it, so the person is asked first; "Продолжить" goes back to it.
  await expect(modal(page).getByRole('heading', { name: 'Есть незавершённый разговор' })).toBeVisible()
  await modalButton(page, 'Продолжить').click()
  await expect(page).toHaveURL(dialogUrl, { timeout: 30_000 })
  // It opens on the voice, with the conversation's latest reply under the sphere: the same
  // conversation, not a second one.
  await expect(page.getByTestId('dialog-voice')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-caption')).toHaveText(lastReply, { timeout: 30_000 })
  await expectHistoryCount(page, 1)

  expect(await violations(), 'нарушения политики безопасности').toEqual([])
})

/**
 * The voice turn and a dropped connection, against the agent mock: it answers a pause in the audio
 * with a recognized line ("[голосовая реплика, N с]") and a reply with speech frames. What is
 * checked is that the microphone on home starts a conversation that listens by itself, that the
 * heard line becomes the person's message, the reply arrives (and its speech does not break the
 * page), and that a drop turns the microphone off and leaves the feed intact.
 */
test('голос в вебе: расшифровка в ленте, обрыв связи выключает микрофон', async ({ page }) => {
  test.setTimeout(120_000)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  // The page keeps its sockets reachable, so the test can cut the connection the way a network does.
  await page.addInitScript(() => {
    const Native = window.WebSocket
    const sockets: WebSocket[] = []
    ;(window as unknown as { __sockets: WebSocket[] }).__sockets = sockets
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    } as typeof WebSocket
  })
  const email = uniqueEmail('web-voice')
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, email)

  // The microphone on home starts the conversation, on the voice, and begins listening as soon as it is connected.
  await page.getByTestId('home-mic').click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
  const mic = page.getByTestId('dialog-mic')
  await expect(mic).toHaveAccessibleName('Остановить запись', { timeout: 30_000 })
  const caption = page.getByTestId('voice-caption')
  const hint = page.getByTestId('voice-hint')
  const user = messages(page, 'user')
  const assistant = messages(page, 'assistant')

  // The greeting is under the sphere.
  await expect(caption).not.toBeEmpty({ timeout: 30_000 })
  const greeting = (await caption.textContent()) ?? ''

  // ── a voice turn ─────────────────────────────────────────────────────────
  await page.waitForTimeout(1200)
  await mic.click()
  await expect(mic).toHaveAccessibleName('Говорить')
  await expect(caption).not.toHaveText(greeting, { timeout: 30_000 })

  // The mock recognizes a pause in the frames: the heard line joins the feed as the person's own.
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  await expect(user).toHaveCount(1, { timeout: 20_000 })
  await expect(user.first()).toContainText('голосовая реплика')
  await expect(assistant).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })

  // ── a drop while the microphone is on ────────────────────────────────────
  // With nothing typed the box's one button is the sphere: it goes back to the voice and listens.
  await page.getByTestId('dialog-mic').click()
  await expect(mic).toHaveAccessibleName('Остановить запись', { timeout: 30_000 })
  await page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1)?.close())
  await expect(page.getByText('микрофон выключен')).toBeVisible({ timeout: 10_000 })
  await expect(mic).not.toHaveAccessibleName('Остановить запись')
  // The connection comes back by itself, and the feed is what it was: nothing lost, nothing twice.
  await expect(hint).toHaveText('Нажми на шар и говори', { timeout: 30_000 })
  await expect(mic).toBeEnabled()
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  await expect(user).toHaveCount(1)
  await expect(assistant).toHaveCount(2)

  // Text still goes out on the new connection.
  await page.getByPlaceholder(DRAFT_PLACEHOLDER).fill('Я снова здесь')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(user).toHaveCount(2, { timeout: 20_000 })
  await expect(assistant).toHaveCount(3, { timeout: 30_000 })
  expect(failures, 'ошибки страницы').toEqual([])
})

/**
 * An agent whose speech is down sends text only. The sphere still reads the greeting with the app's own
 * voice (listening waits for it), but never a reply: a platform voice stepping in over a slow agent made
 * replies sound twice.
 */
test('агент без озвучки: шар в вебе читает приветствие, но не ответ', async ({ page }) => {
  test.setTimeout(120_000)
  await setAgentSpeech('none')
  try {
    await clearMailbox()
    await openWebApp(page)
    await registerAndConfirm(page, uniqueEmail('web-own-voice'))

    await talkButton(page).click()
    const stop = page.getByRole('button', { name: 'Остановить запись' })
    await expect(stop).toBeVisible({ timeout: 30_000 })
    const caption = page.getByTestId('voice-caption')
    await expect(caption).not.toBeEmpty({ timeout: 30_000 })
    const greeting = ((await caption.textContent()) ?? '').trim()
    await expectSpoken(page, greeting)
    expect(await playedBy(page), 'агент ничего не присылал').toBe(0)

    await stop.click()
    await expect(caption).not.toHaveText(greeting, { timeout: 30_000 })
    await expect(caption).toHaveText(/[.!?…]$/, { timeout: 30_000 })
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
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail(name))
  await talkButton(page).click()
  const stop = page.getByRole('button', { name: 'Остановить запись' })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  // Let the mock answer the voice turn first, or its reply lands in the middle of the script.
  await page.waitForTimeout(1200)
  await stop.click()
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder(DRAFT_PLACEHOLDER)
  await expect(input).toBeVisible({ timeout: 30_000 })
  await expect(messages(page, 'assistant')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  return input
}

test('красный уровень в вебе: лист, вопрос о безопасности, 112, возврат из звонка, закреплённая кнопка', async ({
  page,
  shot,
}) => {
  test.setTimeout(150_000)
  const input = await openTextDialog(page, 'web-crisis-red')
  // A tel: link has nowhere to go in a headless browser; the app still sees the tap.
  await page.evaluate(() =>
    document.addEventListener(
      'click',
      (event) => (event.target as Element).closest('a[href^="tel:"]') && event.preventDefault(),
    ),
  )

  await input.fill('кризис-красный')
  await input.press('Enter')
  // Step 1: the sheet of the script, with the way out always in view.
  const sheet = modal(page)
  await expect(sheet.getByRole('heading', { name: 'Сейчас важно поговорить с живым человеком' })).toBeVisible(
    { timeout: 30_000 },
  )
  await expect(sheet.getByTestId('sos-call-now')).toHaveAttribute('href', 'tel:84959895050')
  await expect(sheet.getByTestId('sos-call-now')).toContainText('Позвонить сейчас')
  await expect(sheet.getByTestId('sos-call-112')).toContainText('112 — если есть опасность для жизни')
  await expect(sheet.getByTestId('sos-safe-link')).toHaveText('Я в безопасности, давай продолжим')
  await expect(sheet.getByRole('link', { name: /Московская/ })).toHaveAttribute('href', 'tel:8495051')
  await expect(modalButton(page, 'Закрыть')).toBeVisible()
  await shot(page, 'web-crisis-help')

  // Step 2: the question, in the open sheet.
  await expect(sheet.getByTestId('safe-answers')).toBeVisible({ timeout: 30_000 })
  await expect(sheet.getByTestId('safe-answers').getByRole('button')).toHaveText(['Да', 'Нет', 'Не знаю'])
  await shot(page, 'web-crisis-ask-safe')

  // Step 2a: «Нет» gives the large 112 with the lines below it.
  await sheet.getByTestId('safe-answers').getByRole('button', { name: 'Нет', exact: true }).click()
  await expect(sheet.getByTestId('sos-call-112-big')).toHaveText('112')
  await expect(sheet.getByTestId('safe-answers')).toHaveCount(0)
  await expect(sheet.getByRole('link', { name: /Московская/ })).toBeVisible()
  await shot(page, 'web-crisis-112')

  // Step 4: a tap on a line and the way back to the app: the agent asks how it went.
  await sheet.getByTestId('sos-call-112-big').click()
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  await modalButton(page, 'Закрыть').click()
  await expect(messages(page, 'assistant').last()).toContainText('Получилось поговорить?', {
    timeout: 30_000,
  })

  // Step 2b: the link on step 1 is the answer «Да»; the sheet closes and the call button stays above the conversation.
  await input.fill('кризис-красный')
  await input.press('Enter')
  await expect(sheet.getByTestId('sos-safe-link')).toBeVisible({ timeout: 30_000 })
  await sheet.getByTestId('sos-safe-link').click()
  await expect(sheet).toHaveCount(0)
  await expect(messages(page, 'user').last()).toContainText('Да, я в безопасности')
  const pinned = page.getByTestId('crisis-pinned-call')
  await expect(pinned).toBeVisible({ timeout: 30_000 })
  await expect(pinned).toHaveAttribute('href', 'tel:84959895050')
  // Pinned means it stays on screen when the conversation is long and the page is scrolled to the end.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect(pinned).toBeInViewport()
  await shot(page, 'web-crisis-pinned')

  // The sphere is calm for the whole session: steady light, no pulsing.
  await page.getByRole('button', { name: 'Говорить голосом' }).click()
  await expect(page.locator('[data-slot="voice-orb"][data-calm]')).toHaveCount(1)
  await expect(pinned).toBeVisible()
})

test('жёлтый уровень в вебе: вопрос без листа, ответ «Нет» даёт плашку «Нужна помощь?»', async ({
  page,
  shot,
}) => {
  test.setTimeout(150_000)
  const input = await openTextDialog(page, 'web-crisis-yellow')

  await input.fill('кризис-жёлтый')
  await input.press('Enter')
  await expect(messages(page, 'assistant').last()).toContainText('мысли', { timeout: 30_000 })
  await expect(modal(page)).toHaveCount(0)
  await expect(page.getByTestId('crisis-banner')).toHaveCount(0)

  await input.fill('Нет')
  await input.press('Enter')
  const banner = page.getByTestId('crisis-banner')
  await expect(banner).toHaveText('Нужна помощь?', { timeout: 30_000 })
  await expect(modal(page)).toHaveCount(0)
  await shot(page, 'web-crisis-banner')

  // The banner opens the sheet with the default text and the bundled lines.
  await banner.click()
  await expect(modal(page).getByRole('heading', { name: 'Если сейчас тяжело' })).toBeVisible()
  await expect(modal(page).getByRole('link', { name: /112/ })).toBeVisible()
  await expect(modal(page).getByRole('link', { name: /Московская/ })).toHaveAttribute('href', 'tel:8495051')
})
