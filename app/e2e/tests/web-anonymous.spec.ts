import { randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import { ANONYMOUS_RETENTION_DAYS, POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { APP_URL } from '../playwright.config'
import {
  dismissMemoryInvite,
  button,
  checkConsent,
  closeSidebar,
  dialogInput,
  expectNoHorizontalOverflow,
  field,
  firstHello,
  goTo,
  helloTextButton,
  helloVoiceButton,
  isPhone,
  messages,
  modal,
  modalButton,
  nav,
  openProfile,
  openSidebar,
  openSignIn,
  openWebApp,
  pageTitle,
  PASSWORD,
  registerAndConfirm,
  signIn,
  startAnonymously,
  startFromFirstScreen,
  startTextButton,
  startTextDialog,
  startVoiceButton,
  uniqueEmail,
  watchApiCalls,
  watchCsp,
} from '../support/web'
import { clearMailbox, waitForCode } from '../support/mail'
import {
  deviceLogin,
  profileOf,
  sessionAlive,
  startDialogRefusal,
  storedDevice,
  trackSession,
} from '../support/session'
import { step } from '../support/evidence'
import { expectInsideViewport } from '../support/layout'
import { expect, test } from '../support/fixtures'

// A headless browser has no microphone of its own: the voice start needs the fake device and its
// permission, the same way web-dialog.spec.ts gets them (the desktop project grants nothing by itself).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

/**
 * Anonymous entry, the way a person meets it: the first screen on `/home` — the sphere invites to talk,
 * «Поговорить» and the keyboard under it, the plaque about the service at the foot, and no gate, box or
 * checkbox before it. A press opens the consent window; «Продолжить» there makes the account behind it,
 * records the consents, turns memory on and opens the conversation on the voice or on the text, while
 * the first screen stays up. Later visits meet the signed-in home and no window at all. A profile that
 * offers an address where it has something to give, and a server that keeps to what the app promises.
 * `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия» and «Согласие
 * при первом действии».
 *
 * Scenarios rather than one test per step, for the reason the account scenarios give: every test
 * would start its own session, and the entry points are rate limited per address.
 */

const DEVICE_ID = /^[\w-]{16,64}$/
const DEVICE_KEY = /^[\w-]{32,128}$/
/** The mock agent's greeting for a new conversation. */
const GREETING = 'Я рядом. С чего начнём?'
const PLAQUE =
  'бесплатный ИИ-собеседник, без регистрации. Самоподдержка, а не психотерапия и не медицинская помощь.'
const CONSENT_WITH_MEMORY =
  'включая голос и текст разговоров, и на запоминание важного из них (выключается в профиле).'
const KEEP_DIALOGS = 'Разговоры хранятся 30 дней после последнего сообщения.'
const KEEP_GUEST = 'Без почты аккаунт удаляется через 90 дней без визитов.'

/** The whole stage around the sphere: a press anywhere on it is «Поговорить». */
function helloStage(page: Page) {
  return firstHello(page).locator('[role="presentation"]')
}

/**
 * Records whether home's start button ever enters the document from now on. The way from the first
 * screen to the conversation is a client-side navigation, so the record survives it and tells whether
 * home flashed in between.
 */
async function watchHomeFlash(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const store = window as unknown as { __homeSeen?: boolean }
    const look = () => {
      if (document.querySelector('[data-testid="home-start-voice"]')) store.__homeSeen = true
    }
    store.__homeSeen = false
    look()
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true })
  })
  return () => page.evaluate(() => (window as unknown as { __homeSeen?: boolean }).__homeSeen === true)
}

test('первый экран: шар и плашка без запросов, окно согласия по нажатию, «Поговорить» открывает голос с памятью', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(150_000)
  const violations = await watchCsp(page)
  const session = trackSession(page)
  const apiCalls = watchApiCalls(page)

  // ── a new visitor: the first screen, no gate before it ─────────────────────
  // `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»:
  // «(Web) Первый экран на главной».
  await openWebApp(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('terms-gate'), 'предварительного ворота нет').toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  await expect(firstHello(page).locator('[data-slot="voice-orb"]')).toBeVisible()
  // The invitation is the page's one heading.
  await expect(pageTitle(page)).toHaveCount(1)
  await expect(pageTitle(page)).toHaveAttribute('data-testid', 'hello-caption')
  await expect(pageTitle(page)).toContainText('Привет! Я рядом.')
  await expect(pageTitle(page)).toContainText('Поговорим?')
  await expect(helloVoiceButton(page)).toHaveText('Поговорить')
  await expect(helloVoiceButton(page)).toBeEnabled()
  await expect(helloTextButton(page)).toHaveAccessibleName('Написать текстом')
  await expect(page.getByTestId('hello-plaque')).toContainText(PLAQUE)
  await expect(page.getByTestId('hello-plaque')).toContainText('В опасной ситуации звони 112.')
  // No box, no suggestions and no checkbox: the press is the only way on.
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.locator('[data-testid^="home-suggestion"]')).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByTestId('data-consent')).toHaveCount(0)
  await expect(startVoiceButton(page), 'главной вошедшего нет').toHaveCount(0)
  // The same frame as for an account: SOS in the header, the menu with «Войти» at its foot.
  await expect(page.getByRole('button', { name: 'SOS' })).toBeVisible()
  await openSidebar(page)
  await expect(nav(page).getByRole('link', { name: 'Новый разговор', exact: true })).toBeVisible()
  await expect(nav(page).getByRole('link', { name: 'Люди рядом', exact: true })).toBeVisible()
  await expect(page.getByTestId('have-account')).toHaveText('Войти')
  await closeSidebar(page)
  // «Люди рядом» are open without an account too.
  await openWebApp(page, '/people')
  await expect(page).toHaveURL(/\/people$/)
  await expect(page.getByText('Позвонить прямо сейчас')).toBeVisible()
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-welcome')
  await step(
    page,
    'first-screen',
    'Первый экран: шар, «Привет! Я рядом. Поговорим?», «Поговорить», клавиатура и плашка о сервисе; поля и флажка нет',
  )
  // Nothing is made before the explicit tick and press: no account, no key on the device, no call.
  expect(await storedDevice(page), 'до согласия удостоверения нет').toBeNull()
  expect(apiCalls(), 'первый экран не создаёт запросов').toEqual([])

  // ── «Поговорить» opens the consent window over the first screen ────────────
  // «Первое действие открывает окно согласия», «(Web) Флажок покрывает память», «Строки внизу экрана».
  await helloVoiceButton(page).click()
  await expect(modal(page).getByRole('heading', { name: 'Перед началом' })).toBeVisible()
  await expect(modal(page).getByTestId('data-consent-toggle')).not.toBeChecked()
  await expect(modal(page).getByTestId('consent-continue')).toBeDisabled()
  await expect(modal(page).getByTestId('data-consent')).toContainText(CONSENT_WITH_MEMORY)
  await expect(modal(page).getByRole('link', { name: 'условия использования', exact: true })).toHaveAttribute(
    'href',
    /\/terms$/,
  )
  await expect(
    modal(page).getByRole('link', {
      name: 'согласие на обработку персональных данных',
      exact: true,
    }),
  ).toHaveAttribute('href', /\/consent$/)
  // `openspec/changes/update-privacy-policy`, «Человек знает о сроке хранения разговоров»: the terms are in
  // the window now, under the button.
  const keep = modal(page).getByTestId('guest-note')
  await expect(keep).toContainText(KEEP_DIALOGS)
  await expect(keep).toContainText(KEEP_GUEST)
  const continueBox = (await modal(page).getByTestId('consent-continue').boundingBox())!
  expect((await keep.boundingBox())!.y, 'сроки хранения под кнопкой').toBeGreaterThan(continueBox.y)
  await expect(page).toHaveURL(/\/home$/)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-consent-window')
  await step(
    page,
    'consent-window',
    '«Поговорить» открыл окно согласия: флажок снят и говорит о памяти, «Продолжить» неактивна, сроки хранения под кнопкой',
  )
  expect(apiCalls(), 'окно открылось без запроса').toEqual([])
  expect(await storedDevice(page), 'аккаунт не создан').toBeNull()

  // «Закрытие без подтверждения»: Esc closes it, the person stays on the first screen, nothing is sent.
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  expect(apiCalls(), 'закрытие Esc не отправляет запрос').toEqual([])

  // A press on the sphere is «Поговорить»; the backdrop closes the window the same way.
  await helloStage(page).click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await expect(modal(page).getByTestId('data-consent-toggle'), 'окно монтируется заново').not.toBeChecked()
  const viewport = page.viewportSize()!
  await page.mouse.click(viewport.width / 2, 150)
  await expect(modal(page)).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  expect(apiCalls(), 'закрытие фоном не отправляет запрос').toEqual([])

  // The cross closes it too, and the next press opens it again.
  await helloVoiceButton(page).click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await modal(page).getByTestId('consent-close').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  expect(apiCalls(), 'закрытие крестиком не отправляет запрос').toEqual([])
  expect(await storedDevice(page), 'и аккаунта всё ещё нет').toBeNull()

  // ── the tick, then «Продолжить»: account, consents, memory, the voice ──────
  await helloVoiceButton(page).click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await modal(page).getByTestId('data-consent-toggle').check()
  await expect(modal(page).getByTestId('consent-continue')).toBeEnabled()
  await step(page, 'consent-ticked', 'Флажок отмечен — «Продолжить» стала доступна')

  // The start is held back a moment, so the screen in between can be seen: «(Web) Между первым экраном и
  // разговором нет главной».
  const homeFlashed = await watchHomeFlash(page)
  await page.route('**/api/dialogs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    return route.fallback()
  })
  const isPath = (path: string, method: string) => (r: { url(): string; method(): string }) =>
    new URL(r.url()).pathname === path && r.method() === method
  const memoryOn = page.waitForRequest(isPath('/api/memory/settings', 'PUT'))
  const started = page.waitForResponse((r) => isPath('/api/dialogs', 'POST')(r.request()))
  await modal(page).getByTestId('consent-continue').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(firstHello(page), 'пока идёт старт, на экране первый экран').toBeVisible()
  await expect(helloVoiceButton(page), 'кнопки заняты').toBeDisabled()
  await expect(helloTextButton(page)).toBeDisabled()

  // «Подтверждение продолжает исходное действие», «Начало голосом»: the voice view, which listens after
  // the agent's greeting.
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await page.unroute('**/api/dialogs')
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-caption')).toHaveText(GREETING, { timeout: 30_000 })
  await expect(page.getByTestId('memory-invite'), 'окно про память не мешает началу').toHaveCount(0)
  await step(
    page,
    'voice-after-consent',
    'После «Продолжить» — голосовой вид: приветствие под шаром, идёт прослушивание',
  )
  expect(await homeFlashed(), 'главная не мелькнула между первым экраном и разговором').toBe(false)

  // «(Web) Память с первого разговора»: after the account and the consents, before the conversation, the
  // profile's own request with the memory consent; the conversation then goes with memory. The client
  // names only `off` (with memory is the server's default), so it is the answer that shows the mode.
  const memoryBody = (await memoryOn).postDataJSON() as Record<string, unknown>
  expect(memoryBody).toMatchObject({ enabled: true, consentAccepted: true })
  expect(String(memoryBody.consentVersion)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const start = await started
  expect(start.request().postDataJSON(), 'старт не просит разговор без памяти').not.toHaveProperty(
    'memory',
    'off',
  )
  expect(
    ((await start.json()) as { result: unknown }).result,
    'первый разговор идёт с памятью',
  ).toMatchObject({
    memoryEnabled: true,
    memoryMode: 'on',
  })
  const calls = apiCalls()
  const order = [
    'POST /api/auth/device',
    'POST /api/auth/me/consents',
    'PUT /api/memory/settings',
    'POST /api/dialogs',
  ]
  const positions = order.map((call) => calls.indexOf(call))
  expect(
    positions.every((position) => position >= 0),
    `все шаги старта прошли: ${calls.join(', ')}`,
  ).toBe(true)
  expect(
    [...positions].sort((a, b) => a - b),
    'аккаунт → согласия → память → разговор',
  ).toEqual(positions)

  const device = await storedDevice(page)
  expect(device?.deviceId, 'идентификатор устройства сохранён').toMatch(DEVICE_ID)
  expect(device?.deviceKey, 'ключ устройства сохранён').toMatch(DEVICE_KEY)
  // The server holds what was agreed to, and the account has nothing else: no address, no name.
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: session.userId(),
    email: null,
    name: null,
    consentsCompleted: true,
    consentVersion: POLICY_VERSION,
  })
  expect(await violations(), 'нарушения политики безопасности').toEqual([])
})

test('первый экран, значок клавиатуры: окно согласия, затем чат с приветствием и пустым полем, без микрофона', async ({
  page,
}) => {
  test.setTimeout(120_000)
  // Counts the microphone requests: the text start must not ask for it.
  await page.addInitScript(() => {
    const store = window as unknown as { __micAsked: number }
    store.__micAsked = 0
    const media = navigator.mediaDevices
    if (!media) return
    const ask = media.getUserMedia.bind(media)
    media.getUserMedia = (constraints) => {
      store.__micAsked += 1
      return ask(constraints)
    }
  })
  const micAsked = () => page.evaluate(() => (window as unknown as { __micAsked: number }).__micAsked)
  const apiCalls = watchApiCalls(page)

  // `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»: «(Web) Начало
  // текстом» — the keyboard opens the same window, and nothing is sent before the tick.
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  await helloTextButton(page).click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await expect(modal(page).getByTestId('consent-continue')).toBeDisabled()
  expect(apiCalls(), 'до подтверждения запросов нет').toEqual([])
  await modal(page).getByTestId('data-consent-toggle').check()
  await modal(page).getByTestId('consent-continue').click()

  // The text view: the agent's greeting first, an empty box, no listening and no microphone.
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(dialogInput(page)).toBeVisible({ timeout: 30_000 })
  await expect(messages(page, 'assistant').first()).toContainText(GREETING, { timeout: 30_000 })
  await expect(dialogInput(page)).toHaveValue('')
  await expect(messages(page, 'user'), 'черновика нет: первым сообщением ничего не ушло').toHaveCount(0)
  await expect(page.getByTestId('dialog-voice')).toHaveCount(0)
  // Connected: the box's own way back to the voice is ready, and still nobody asked for the microphone.
  await expect(page.getByTestId('dialog-mic')).toBeEnabled({ timeout: 30_000 })
  await page.waitForTimeout(1_000)
  expect(await micAsked(), 'микрофон не запрашивался').toBe(0)
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toHaveCount(0)
  await step(
    page,
    'text-after-keyboard',
    'Клавиатура и «Продолжить»: чат с приветствием агента и пустым полем, микрофон не включался',
  )

  // `openspec/changes/rework-web-first-screen`, «Начало разговора с главного экрана»: «(Web) Старт
  // текстом» — the conversation keeps its text view when the person comes back to it.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(dialogInput(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dialog-voice')).toHaveCount(0)

  // «Память включает сам человек», «(web) Новый человек»: the tick turned memory on, and the profile is
  // where it is turned off.
  await openWebApp(page, '/profile/memory')
  await expect(page.getByRole('heading', { level: 1, name: 'Память', exact: true })).toBeVisible()
  await expect(page.getByTestId('memory-switch').getByRole('checkbox')).toBeChecked()
})

test('второй заход: главная вошедшего с галочкой памяти и вопрос о незавершённом разговоре; дальше без экранов', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const session = trackSession(page)

  // A newcomer comes in by the voice and says one line, so the conversation is left with something in it.
  await openWebApp(page)
  await startFromFirstScreen(page, 'voice')
  const accountId = session.userId()
  const stop = page.getByRole('button', { name: 'Остановить запись' })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const caption = page.getByTestId('voice-caption')
  await expect(caption).toHaveText(GREETING, { timeout: 30_000 })
  await page.waitForTimeout(1200)
  await stop.click()
  await expect(caption).not.toHaveText(GREETING, { timeout: 30_000 })
  // The turn is in the feed only once the mock has heard it and answered: the next visit must find it there.
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })

  // ── the next visit: the signed-in home, not the first screen ───────────────
  // `openspec/changes/rework-web-first-screen`, «Главная веб-клиента: старт голосом или текстом» and
  // «Разговор „Без памяти“»: memory was turned on at the first start, so the tick is there.
  await openWebApp(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(startVoiceButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(startVoiceButton(page)).toHaveText('Начать разговор')
  await expect(startTextButton(page)).toHaveAccessibleName('Начать текстом')
  await expect(firstHello(page)).toHaveCount(0)
  await expect(pageTitle(page)).toHaveCount(1)
  await expect(pageTitle(page)).toHaveAttribute('data-testid', 'home-greeting')
  await expect(page.getByTestId('incognito')).toContainText('Не запоминать этот разговор')
  await expect(page.getByTestId('incognito-toggle')).not.toBeChecked()
  await expect(page.getByText('Запоминать важное')).toHaveCount(0)
  // The foot of home with an account: the agreement with the terms and the policy, no consent window.
  await expect(page.getByTestId('consent-notice')).toBeVisible()
  await expect(page.getByTestId('guest-note')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
  await step(
    page,
    'home-returning',
    'Второй заход: главная вошедшего — приветствие, «Начать разговор», клавиатура и «Не запоминать этот разговор»',
  )

  // `openspec/changes/rework-web-first-screen`, «Начало разговора с главного экрана»: «(Web) Незавершённый
  // разговор перед стартом» — the start asks first; «Закрыть» keeps the person on home.
  await startVoiceButton(page).click()
  await expect(modal(page).getByRole('heading', { name: 'Есть незавершённый разговор' })).toBeVisible()
  await expect(modal(page).getByTestId('resume-continue')).toBeVisible()
  await expect(modal(page).getByTestId('resume-new')).toBeVisible()
  await expect(modal(page).getByTestId('resume-note'), 'галочка не стоит — пометки нет').toHaveCount(0)
  await step(
    page,
    'resume-question',
    'Перед новым разговором — вопрос о незавершённом: «Продолжить», «Завершить и начать новый», «Закрыть»',
  )
  await modal(page).getByTestId('resume-close').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/home$/)
  await expect(startVoiceButton(page)).toBeEnabled()

  // ── the session is gone but the device is known: `/` signs back in, with no screen at all ─
  await page.evaluate(() => {
    localStorage.removeItem('ryadom_refreshToken')
    localStorage.removeItem('ryadom.user')
  })
  await openWebApp(page)
  await expect(startVoiceButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/home$/)
  expect(session.userId(), 'тот же аккаунт, не новый').toBe(accountId)

  // ── a browser that knows nothing about this person meets the first screen ─
  await page.evaluate(() => localStorage.clear())
  await openWebApp(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(firstHello(page)).toBeVisible()
  await expect(page.getByTestId('terms-gate'), 'ворота нет и для нового браузера').toHaveCount(0)
})

test('первый экран: сбой старта — ошибка на первом экране, повтор без окна согласия', async ({ page }) => {
  test.setTimeout(90_000)
  // `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»: «Сбой
  // начала». The account and the consents succeed (the window did that), only the start itself fails.
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  await helloVoiceButton(page).click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await modal(page).getByTestId('data-consent-toggle').check()
  await page.route('**/api/dialogs', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      : route.fallback(),
  )
  await modal(page).getByTestId('consent-continue').click()

  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('form-error')).not.toBeEmpty()
  await expect(page).toHaveURL(/\/home$/)
  await expect(firstHello(page), 'человек остаётся на первом экране').toBeVisible()
  await expect(startVoiceButton(page), 'главная не показалась').toHaveCount(0)
  await expect(helloVoiceButton(page)).toBeEnabled()
  await expect(helloTextButton(page)).toBeEnabled()
  await step(page, 'start-failed', 'Старт не удался: ошибка на первом экране, кнопки снова доступны')

  // The retry goes straight to the start: the window does not come back.
  await page.unroute('**/api/dialogs')
  await helloVoiceButton(page).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(modal(page), 'повторное окно согласия не открывается').toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
})

test('первый экран на телефоне 360×780: шар, приглашение, кнопки и плашка с 112 без прокрутки', async ({
  page,
}) => {
  // `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»: «(Web) Экран
  // целиком на телефоне».
  await page.setViewportSize({ width: 360, height: 780 })
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  for (const part of [
    firstHello(page).locator('[data-slot="voice-orb"]'),
    page.getByTestId('hello-caption'),
    helloVoiceButton(page),
    helloTextButton(page),
    page.getByTestId('hello-plaque'),
  ]) {
    await expect(part).toBeVisible()
    await expectInsideViewport(page, part)
  }
  await expect(page.getByTestId('hello-plaque')).toContainText('В опасной ситуации звони 112.')
  // Neither the page nor the frame's scrolling column has anything below the window.
  const below = await page.evaluate(() => {
    const scrolling = document.scrollingElement!
    const main = document.getElementById('main')
    return Math.max(
      scrolling.scrollHeight - scrolling.clientHeight,
      main ? main.scrollHeight - main.clientHeight : 0,
    )
  })
  expect(below, 'первый экран не прокручивается').toBeLessThanOrEqual(1)
  await expectNoHorizontalOverflow(page)
})

test('сервер не начинает разговор без согласий, и «мне нет 18» — отдельный отказ', async ({ request }) => {
  const device = {
    deviceId: randomBytes(16).toString('base64url'),
    deviceKey: randomBytes(32).toString('base64url'),
  }
  // The account is made first and the agreements come after (the first screen does both in a row),
  // so a client that skips the second step is stopped here, not by the screen.
  const { tokens } = await deviceLogin(request, device)
  const asClient = { Authorization: `Bearer ${tokens.accessToken}` }
  expect(await startDialogRefusal(request, tokens.accessToken)).toBe('CONSENT_REQUIRED')

  const consent = (data: object) =>
    request.post(`${APP_URL}/api/auth/me/consents`, { headers: asClient, data })
  const all = {
    ageConfirmed: true,
    disclaimerAccepted: true,
    offerAccepted: true,
    offerVersion: POLICY_VERSION,
  }

  const minor = (await (await consent({ ...all, ageConfirmed: false })).json()) as { errorCode?: string }
  expect(minor.errorCode).toBe('AGE_RESTRICTED')
  const partial = (await (await consent({ ...all, offerAccepted: false })).json()) as { errorCode?: string }
  expect(partial.errorCode).toBe('CONSENT_DECLINED')
  expect(await startDialogRefusal(request, tokens.accessToken), 'отказы ничего не записали').toBe(
    'CONSENT_REQUIRED',
  )

  expect(((await (await consent(all)).json()) as { status: boolean }).status).toBe(true)
  expect(await startDialogRefusal(request, tokens.accessToken)).toBeNull()
})

test('аккаунт без почты: профиль, привязка, подтверждение — выход появляется, ключ устройства забыт', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const email = uniqueEmail('web-anonymous')
  await clearMailbox()

  await openWebApp(page)
  await startAnonymously(page)
  const accountId = session.userId()

  // ── the profile offers an address, not a password, and says how long the account lives ─
  await openProfile(page)
  await expect(page.getByTestId('profile-email')).toHaveText('Без регистрации')
  await expect(page.getByTestId('profile-name')).toHaveText('Гость')
  await expect(page.getByTestId('row-link-email')).toBeVisible()
  await expect(page.getByTestId('row-change-password'), 'у аккаунта без пароля его нечем менять').toHaveCount(
    0,
  )
  await expect(page.getByTestId('row-confirm-email')).toHaveCount(0)
  await expect(page.getByTestId('row-sessions'), 'у гостя одно устройство: смотреть нечего').toHaveCount(0)
  await expect(
    page.getByText(new RegExp(`${ANONYMOUS_RETENTION_DAYS} дней после последнего визита`)),
  ).toBeVisible()
  // Nothing to sign out of: this phone is the only way in. Leaving is going to another account.
  await expect(page.getByTestId('logout'), 'выхода из такого аккаунта нет').toHaveCount(0)
  await expect(page.getByTestId('row-switch-account')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-profile')

  // The sidebar says it is a guest and offers to keep the conversations, the way other chats do for
  // someone who has not signed in; a signed-in account gets no such card.
  await openSidebar(page)
  await expect(page.getByTestId('account-menu')).toContainText('Гость')
  await expect(page.getByTestId('guest-card')).toContainText('Сохрани аккаунт')
  await expect(page.getByTestId('guest-card-link')).toHaveAttribute('href', '/profile?linkEmail=1')
  await shot(page, 'web-anonymous-guest-card')
  await closeSidebar(page)

  await page.getByTestId('edit-name').click()
  await modal(page).locator('input[name="name"]').fill('Аноним')
  await page.getByTestId('name-save').click()
  await expect(page.getByTestId('profile-name')).toHaveText('Аноним')

  // ── linking: the form checks before it asks, then the code from the email ─
  const address = page.getByTestId('link-email-address')
  const password = page.getByTestId('link-email-password')
  const formError = page.getByTestId('form-error')
  await page.getByTestId('row-link-email').click()
  await expect(modal(page).getByRole('heading', { name: 'Почта для входа' })).toBeVisible()
  await expect(
    modal(page).getByText(new RegExp(`удаляется через ${ANONYMOUS_RETENTION_DAYS} дней`)),
  ).toBeVisible()
  await address.fill('not-an-address')
  await password.fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()
  await expect(formError).toHaveText('Проверь адрес почты')
  await address.fill(email)
  await password.fill('short')
  await page.getByTestId('link-email-submit').click()
  await expect(formError).toContainText('Пароль')
  await password.fill(PASSWORD)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-link-email')
  await page.getByTestId('link-email-submit').click()

  const code = page.getByTestId('link-email-code')
  await expect(code).toBeVisible({ timeout: 20_000 })
  await code.fill('000000')
  await page.getByTestId('link-email-confirm').click()
  await expect(formError).toContainText('Код не подошёл', { timeout: 20_000 })
  await code.fill(await waitForCode(email))
  await page.getByTestId('link-email-confirm').click()
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 })
  await expect(modal(page)).toHaveCount(0)

  // ── now it is an ordinary account: a password, a way out, and no device key ─
  await expect(page.getByTestId('profile-email')).toHaveText(email)
  await expect(page.getByTestId('profile-name')).toHaveText('Аноним')
  await expect(page.getByTestId('row-change-password')).toBeVisible()
  await expect(
    page.getByTestId('row-sessions'),
    'с подтверждённой почтой войти можно с другого устройства',
  ).toBeVisible()
  await expect(page.getByTestId('row-link-email')).toHaveCount(0)
  await expect(page.getByTestId('row-switch-account')).toHaveCount(0)
  await expect(page.getByTestId('logout')).toBeVisible()
  await expect(page.getByText(/дней после последнего визита/)).toHaveCount(0)
  await openSidebar(page)
  await expect(page.getByTestId('guest-card'), 'у аккаунта с почтой карточки гостя нет').toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toContainText(email)
  await closeSidebar(page)
  expect(await storedDevice(page), 'ключ устройства забыт: у аккаунта есть пароль').toBeNull()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email,
    isEmailConfirmed: true,
    consentsCompleted: true,
  })
  await shot(page, 'web-anonymous-linked')

  // ── signing out really signs out: the next visit is a stranger's, the way back is the address ─
  await page.getByTestId('logout').click()
  await page.getByTestId('logout-confirm').click()
  await expect(page).toHaveURL(/\/login$/)
  await openWebApp(page)
  // No gate for a stranger: the first screen, the sign-in stays at the foot of the menu.
  await expect(page.getByTestId('terms-gate')).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  await openSignIn(page)
  await signIn(page, email)
  await openProfile(page)
  await expect(page.getByTestId('profile-name'), 'тот же аккаунт со всем, что в нём было').toHaveText(
    'Аноним',
  )
  expect(session.userId()).toBe(accountId)
})

test('почта уже занята: что будет с разговорами сказано, путь в тот аккаунт есть', async ({
  page,
  newDevice,
  shot,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const taken = uniqueEmail('web-taken')
  await clearMailbox()

  // Someone already has an account with this address, on another device.
  const owner = await newDevice()
  const ownerSession = trackSession(owner)
  await openWebApp(owner)
  await registerAndConfirm(owner, taken, 'Хозяйка')

  await openWebApp(page)
  await startAnonymously(page)
  const anonymousId = session.userId()
  await openProfile(page)
  await page.getByTestId('row-link-email').click()
  await page.getByTestId('link-email-address').fill(taken)
  await page.getByTestId('link-email-password').fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()

  // The answer says it plainly, and offers the other account.
  const formError = page.getByTestId('form-error')
  await expect(formError).toContainText('Эта почта уже занята', { timeout: 20_000 })
  await expect(formError).toContainText('не перенесутся')
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-email-taken')
  await page.getByTestId('link-email-switch').click()
  await expect(modal(page).getByRole('heading', { name: 'Войти в другой аккаунт' })).toBeVisible()
  await expect(modal(page)).toContainText(`через ${ANONYMOUS_RETENTION_DAYS} дней`)
  await shot(page, 'web-anonymous-switch-account')

  // Declining leaves everything as it was.
  await modalButton(page, 'Отмена').click()
  await expect(modal(page)).toHaveCount(0)
  expect(await storedDevice(page), 'отказавшись, человек остаётся в своём аккаунте').not.toBeNull()

  await page.getByTestId('row-switch-account').click()
  await page.getByTestId('switch-account-confirm').click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await storedDevice(page), 'уйдя, человек забыл удостоверение: вернуться нельзя').toBeNull()
  await signIn(page, taken)
  await openProfile(page)
  await expect(page.getByTestId('profile-email')).toHaveText(taken)
  expect(session.userId(), 'это тот аккаунт, а не прежний анонимный').toBe(ownerSession.userId())
  expect(session.userId()).not.toBe(anonymousId)
})

test('привязка почты, начатая и брошенная, продолжается с шага кода', async ({ page }) => {
  test.setTimeout(120_000)
  const email = uniqueEmail('web-pending')
  await clearMailbox()

  await openWebApp(page)
  await startAnonymously(page)
  await openProfile(page)
  await page.getByTestId('row-link-email').click()
  await page.getByTestId('link-email-address').fill(email)
  await page.getByTestId('link-email-password').fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()
  await expect(page.getByTestId('link-email-code')).toBeVisible({ timeout: 20_000 })

  // The dialog is closed without the code, and the page is reloaded for good measure.
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByTestId('profile-email')).toHaveText(email)
  const confirmRow = page.getByTestId('row-confirm-email')
  await expect(confirmRow).toContainText(email)
  await expect(page.getByTestId('row-link-email'), 'адрес уже указан').toHaveCount(0)
  await expect(
    page.getByTestId('row-sessions'),
    'пока почта не подтверждена, список устройств не нужен',
  ).toHaveCount(0)
  // Not confirmed yet: this phone is still the only way in, so there is still nothing to sign out of.
  await expect(page.getByTestId('logout')).toHaveCount(0)
  await expect(page.getByTestId('row-switch-account')).toBeVisible()

  // It opens at the code step, not at the form; a new code can be asked for and is the one that works.
  await confirmRow.click()
  const code = page.getByTestId('link-email-code')
  await expect(code).toBeVisible()
  await expect(page.getByTestId('link-email-address')).toHaveCount(0)
  await clearMailbox()
  await modalButton(page, 'Отправить ещё раз').click()
  await expect(page.getByText('Отправили новый код')).toBeVisible()
  await code.fill(await waitForCode(email))
  await page.getByTestId('link-email-confirm').click()
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 })
  await expect(modal(page)).toHaveCount(0)
  await expect(confirmRow).toHaveCount(0)
  await expect(page.getByTestId('logout')).toBeVisible()
})

test('удаление аккаунта без регистрации: устройство забыто, дальше — первый экран и новый аккаунт', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const session = trackSession(page)

  await openWebApp(page)
  await startAnonymously(page)
  const oldAccount = session.userId()
  const oldSession = session.refreshToken()
  const oldDevice = (await storedDevice(page))!
  expect(oldDevice).not.toBeNull()

  await openProfile(page)
  await page.getByTestId('edit-name').click()
  await modal(page).locator('input[name="name"]').fill('Аноним')
  await page.getByTestId('name-save').click()
  await expect(page.getByTestId('profile-name')).toHaveText('Аноним')

  await page.getByTestId('row-delete-account').click()
  await expect(page.getByText('Удаляется аккаунт без регистрации')).toBeVisible()
  // Two consequences, not three: there is no address to free.
  await expect(page.getByTestId('consequences').getByRole('listitem')).toHaveCount(2)
  await expect(page.getByText('Почта освободится')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
  await checkConsent(page)
  await page.getByTestId('delete-account').click()
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('deleted-message')).toBeVisible({ timeout: 30_000 })
  expect(await storedDevice(page), 'ключ устройства стёрт вместе с аккаунтом').toBeNull()
  await page.getByTestId('deleted-ok').click()
  // Back at the start — the first screen, not a sign-in for an account the person never had.
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('terms-gate')).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()

  expect(await sessionAlive(request, oldSession), 'сессия удалённого аккаунта закончена').toBe(false)

  // The old key no longer leads to the old account: the same key makes a new one.
  const reused = await deviceLogin(request, oldDevice)
  expect(reused.isNewAccount).toBe(true)
  expect(reused.user.id).not.toBe(oldAccount)

  // And the same browser starts over: a new account with a key of its own, and no name from before.
  await startAnonymously(page)
  expect(session.userId()).not.toBe(oldAccount)
  const newDevice = (await storedDevice(page))!
  expect(newDevice.deviceId).not.toBe(oldDevice.deviceId)
  await openProfile(page)
  await expect(page.getByTestId('profile-name'), 'имя прежнего аккаунта не вернулось').toHaveText('Гость')
})

test('после первого разговора предложена почта, а в журнале напоминание; зарегистрированному — нет', async ({
  page,
  shot,
}) => {
  test.setTimeout(150_000)
  await openWebApp(page)
  await startAnonymously(page)

  await startTextDialog(page, 'Сегодня было тяжело')
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialogInput(page)).toBeVisible()

  await page.getByTestId('dialog-end').click()
  await page.getByTestId('takeaway-input').fill('Стало чуть легче')
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })

  // The conversation is over, and the one thing the person stands to lose is said out loud.
  const offer = page.getByTestId('alert-offer')
  await expect(offer).toContainText(`${ANONYMOUS_RETENTION_DAYS} дней`)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-closing-offer')
  await page.getByTestId('alert-offer-action').click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(modal(page).getByRole('heading', { name: 'Почта для входа' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)

  // The journal reminds as well, with a way to the same dialog.
  await goTo(page, 'Все разговоры')
  await expect(page).toHaveURL(/\/diary\/journal$/)
  const reminder = page.getByTestId('journal-link-email')
  await expect(page.getByTestId('journal-item').first()).toBeVisible({ timeout: 20_000 })
  if (isPhone(page)) {
    await expect(reminder).toBeVisible()
    await expect(reminder.getByRole('link', { name: 'Привязать почту' })).toHaveAttribute(
      'href',
      '/profile?linkEmail=1',
    )
  } else {
    // Where the sidebar is a column it carries the same offer, and the journal does not repeat it.
    await expect(reminder).toBeHidden()
    await expect(page.getByTestId('guest-card')).toBeVisible()
  }
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-journal')
})

test('вход по почте на новом устройстве даёт тот же аккаунт, а прежнее удостоверение ему не мешает', async ({
  page,
  newDevice,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const email = uniqueEmail('web-second-device')
  await clearMailbox()

  await openWebApp(page)
  await startAnonymously(page)
  const accountId = session.userId()
  await openProfile(page)
  await page.getByTestId('row-link-email').click()
  await page.getByTestId('link-email-address').fill(email)
  await page.getByTestId('link-email-password').fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()
  await page.getByTestId('link-email-code').fill(await waitForCode(email))
  await page.getByTestId('link-email-confirm').click()
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 })

  // Another phone: the address and the password are all it needs.
  const other = await newDevice()
  const otherSession = trackSession(other)
  await openWebApp(other)
  await dismissMemoryInvite(other) // a new device: the sheet "Рядом теперь запоминает важное" is not this test's subject
  await expect(other.getByTestId('terms-gate')).toHaveCount(0)
  await expect(firstHello(other)).toBeVisible()
  await openSignIn(other)
  await field(other, 'email').fill(email)
  await field(other, 'password').fill(PASSWORD)
  await button(other, 'Войти').click()
  await expect(startVoiceButton(other)).toBeVisible({ timeout: 30_000 })
  expect(otherSession.userId()).toBe(accountId)
  await openProfile(other)
  await expect(other.getByTestId('profile-name')).toHaveText('—')
  await expect(other.getByTestId('profile-email')).toHaveText(email)
  await expect(other.getByTestId('logout'), 'у аккаунта с почтой выход есть').toBeVisible()
})
