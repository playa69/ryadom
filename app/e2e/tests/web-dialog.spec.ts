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
  // Only venting works in v0: the other modes are visibly dimmed instead of promising more.
  await expect(page.getByRole('button', { name: 'Выговориться' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: /Поболтать/ })).toBeDisabled()
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
  expect((await page.getByTestId('dialog-feed').boundingBox())!.width, 'колонка чтения не шире 768px').toBeLessThanOrEqual(770)
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
  const said = page.getByTestId('journal-messages').getByTestId('dialog-message').filter({ hasText: FIRST_MESSAGE })
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
