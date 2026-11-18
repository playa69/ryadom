import type { Locator, Page } from '@playwright/test'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { PWA_URL } from '../playwright.config'
import {
  button,
  consentSheet,
  expectNoHorizontalOverflow,
  firstHello,
  helloText,
  helloVoice,
  homeStartText,
  homeStartVoice,
  openApp,
  startAnonymously,
} from '../support/app'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'
import { expectInsideViewport } from '../support/layout'
import { playedBy, spokenBy } from '../support/speech'
import { profileOf, storedDevice, trackSession } from '../support/session'

/**
 * The PWA first screen and home after `openspec/changes/rework-web-first-screen`: a new person lands on the
 * first screen (the sphere, «Поговорить», the keyboard) with no gate and no form, the theme switch works
 * locally, and any press opens the consent sheet over it instead of sending anything. Plus the start
 * itself: «Продолжить» opens the conversation by voice or in the text view with an empty box, the first
 * typed message goes out exactly once (a reconnect or a second mount does not duplicate it), and the
 * question about an unfinished conversation keeps the voice-or-text intention.
 *
 * The Telegram Mini App is the same code on home; its specifics (the Telegram account) live in
 * app-telegram.spec.ts. The native shell is not covered here: Playwright runs the web build, where
 * `isNative()` is false, so the kept native branch (the gate, voice-only start, dark-only palette)
 * is fixed by the unit tests of consent-gate instead.
 */

/**
 * What may not leave the device before the consent is confirmed: account, consent and conversation
 * calls. Analytics is app-level and anonymous (and partly stubbed in this stack), so the watch is
 * on the personal endpoints, as in web-anonymous.spec.ts.
 */
const PERSONAL_REQUEST = /^\/api\/(auth|dialogs)(\/|$)/

function trackPersonalRequests(page: Page): string[] {
  const calls: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (PERSONAL_REQUEST.test(path)) calls.push(`${request.method()} ${path}`)
  })
  return calls
}

// Fixed local times (the stand and the browser share Europe/Moscow): noon is light, 23:00 is dark.
const DAY = '2026-11-16T12:00:00+03:00'
const NIGHT = '2026-11-16T23:00:00+03:00'
const BEFORE_DARK_BOUNDARY = '2026-11-16T21:59:50+03:00'
const BEFORE_LIGHT_BOUNDARY_NEXT_DAY = '2026-11-17T06:59:55+03:00'
// The values of --ryadom-paper in the design tokens; the browser chrome color follows them.
const LIGHT_PAPER = '#f4f6fd'
const DARK_PAPER = '#00051a'

interface ThemeState {
  dataTheme: string | null
  darkClass: boolean
  colorScheme: string
  paper: string
  metaColorScheme: string | null
  metaThemeColor: string | null
  manualChoice: string | null
}

/** The marks the boot script and the runtime leave on the document, plus the stored manual choice. */
async function themeState(page: Page): Promise<ThemeState> {
  return page.evaluate((key) => {
    const root = document.documentElement
    return {
      dataTheme: root.getAttribute('data-theme'),
      darkClass: root.classList.contains('dark'),
      colorScheme: root.style.colorScheme,
      paper: getComputedStyle(root).getPropertyValue('--ryadom-paper').trim(),
      metaColorScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
      metaThemeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      manualChoice: window.localStorage.getItem(key),
    }
  }, 'ryadom.theme')
}

function expectLightTheme(state: ThemeState): void {
  expect(state.dataTheme).toBe('light')
  expect(state.darkClass).toBe(false)
  expect(state.colorScheme).toBe('light')
  expect(state.paper).toBe(LIGHT_PAPER)
  expect(state.metaColorScheme).toBe('light')
  expect(state.metaThemeColor).toBe(LIGHT_PAPER)
}

function expectDarkTheme(state: ThemeState): void {
  expect(state.dataTheme).toBeNull()
  expect(state.darkClass).toBe(true)
  expect(state.colorScheme).toBe('dark')
  expect(state.paper).toBe(DARK_PAPER)
  expect(state.metaColorScheme).toBe('dark')
  expect(state.metaThemeColor).toBe(DARK_PAPER)
}

/** Visible, whole inside the window, and not lying over one another. */
async function expectFitting(page: Page, actions: Locator[]): Promise<void> {
  const viewport = page.viewportSize()!
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  for (const action of actions) {
    await expect(action).toBeVisible()
    const box = await action.boundingBox()
    expect(box, 'у элемента нет рамки').not.toBeNull()
    expect(box!.x, 'элемент выходит за левый край').toBeGreaterThanOrEqual(-1)
    expect(box!.x + box!.width, 'элемент выходит за правый край').toBeLessThanOrEqual(viewport.width + 1)
    boxes.push(box!)
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, b] = [boxes[i]!, boxes[j]!]
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlap, 'элементы шапки перекрываются').toBe(false)
    }
  }
}
// `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия» («Что видит новый
// человек», «Ничего не уходит до согласия») и «Согласие при первом действии» («Главная доступна до согласия»).
test('первый экран нового человека: шар, приглашение, кнопки и тема сразу, без ворот, формы и запросов', async ({
  page,
}) => {
  const calls = trackPersonalRequests(page)
  await openApp(page)

  const first = page.locator('.page-current')
  await expect(firstHello(page)).toBeVisible()
  await expect(first.getByTestId('hello-caption')).toContainText('Привет! Я рядом.')
  await expect(first.getByTestId('hello-caption')).toContainText('Поговорим?')
  await expect(helloVoice(page)).toContainText('Поговорить')
  await expect(helloText(page)).toHaveAccessibleName('Написать текстом')
  await expect(first.getByTestId('hello-plaque')).toContainText('бесплатный ИИ-собеседник, без регистрации')
  await expect(first.getByTestId('hello-plaque')).toContainText('В опасной ситуации звони 112.')
  await expect(first.getByTestId('welcome-talk'), 'прежнего входного ворота нет').toHaveCount(0)
  // No box, no suggestions, no settings and no checkbox: the press is the only way on.
  await expect(first.locator('textarea')).toHaveCount(0)
  await expect(first.getByTestId('start-suggestion')).toHaveCount(0)
  await expect(first.getByTestId('home-settings')).toHaveCount(0)
  await expect(first.getByTestId('memory-switch')).toHaveCount(0)
  await expect(first.getByTestId('data-consent-toggle')).not.toBeVisible()
  await expect(button(page, 'Отправить')).toHaveCount(0)
  await expect(first.getByTestId('theme-switch')).toBeVisible()
  await expect(first.getByTestId('have-account')).toHaveText('Войти')
  await expect(page.locator('.rd-sos-button')).toBeVisible()
  expect(await storedDevice(page), 'до согласия удостоверения нет').toBeNull()
  await step(
    page,
    'app-home-first',
    'Первый экран нового человека: шар, «Привет! Я рядом.», «Поговорить» и клавиатура, плашка про 112, ворот нет',
  )

  // The theme switch is local too.
  const themeBefore = (await themeState(page)).dataTheme
  await first.getByTestId('theme-switch').click()
  expect((await themeState(page)).dataTheme, 'тема переключилась').not.toBe(themeBefore)

  expect(calls, 'первый экран и тема не создают аккаунт, разговор или запрос').toEqual([])
  expect(await storedDevice(page), 'аккаунт так и не создан').toBeNull()
})

// `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия» («(Web) Экран
// целиком на телефоне»), here for the PWA.
test('первый экран на телефоне 360×780: шар, приглашение, кнопки и плашка с 112 без прокрутки', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await openApp(page)
  await expect(firstHello(page)).toBeVisible()
  for (const part of [
    firstHello(page).locator('.rd-orb').first(),
    page.getByTestId('hello-caption'),
    helloVoice(page),
    helloText(page),
    page.getByTestId('hello-plaque'),
  ]) {
    await expect(part).toBeVisible()
    await expectInsideViewport(page, part)
  }
  await expect(page.getByTestId('hello-plaque')).toContainText('В опасной ситуации звони 112.')
  // Nothing of the screen lies below the window: neither the document nor the page's own scroller.
  const below = await page.evaluate(() => {
    const scrolling = document.scrollingElement!
    const content = document.querySelector('.page-current .page-content')
    return Math.max(
      scrolling.scrollHeight - scrolling.clientHeight,
      content ? content.scrollHeight - content.clientHeight : 0,
    )
  })
  expect(below, 'первый экран не прокручивается').toBeLessThanOrEqual(1)
  await expectNoHorizontalOverflow(page)
  await step(page, 'app-home-first-360', 'Первый экран на 360×780 помещается целиком, без прокрутки')
})

// `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия» («Приветствие
// звучит»), here for the PWA.
test('первый экран: приветствие звучит при первом нажатии, если браузер не дал начать сам', async ({
  page,
}) => {
  // A browser refuses sound before a gesture: the stub refuses the first try and records what is played after.
  await page.addInitScript(() => {
    const played: string[] = []
    ;(window as unknown as { __helloPlayed: string[] }).__helloPlayed = played
    let allowed = false
    window.addEventListener('pointerdown', () => (allowed = true), { capture: true })
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!allowed) return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
      played.push(this.src)
      return Promise.resolve()
    }
  })
  // Not openApp: its click on the install banner would itself be the gesture that allows sound.
  await page.goto(`${PWA_URL}/`)
  await expect(firstHello(page)).toBeVisible({ timeout: 30_000 })
  const played = () => page.evaluate(() => (window as unknown as { __helloPlayed: string[] }).__helloPlayed)
  expect(await played(), 'до нажатия звука нет').toEqual([])
  await firstHello(page).locator('.rd-first-hello-stage').click()
  await expect.poll(played).toHaveLength(1)
  expect((await played())[0]).toContain('hello-greeting')
})

// `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента» («(PWA, Telegram)
// Шапка без перекрытий»).
test('шапка на 390: переключатель темы, SOS и «Войти» видны целиком и не перекрываются', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)

  const home = page.locator('.page-current')
  await expectFitting(page, [
    home.getByTestId('theme-switch'),
    home.getByTestId('have-account'),
    home.locator('.rd-sos-button'),
  ])
  await step(page, 'app-header-390', 'Шапка на 390: тема, «Войти» и SOS не перекрывают друг друга')

  // The same for the signed-in home: the corner theme switch against SOS.
  await startAnonymously(page)
  await expectFitting(page, [home.getByTestId('theme-switch'), home.locator('.rd-sos-button')])
  await step(page, 'app-header-390-signed', 'Шапка вошедшего на 390: тема и SOS не перекрываются')
})

// `openspec/changes/rework-web-first-screen`, «Согласие при первом действии»: «Окно согласия при голосовом
// старте и при старте текстом», ««Продолжить» неактивна до отметки», «Закрытие ничего не отправляет»,
// «Документы из окна согласия».
test('лист согласия: открывают «Поговорить», шар и клавиатура; отметка, закрытие кнопкой, Esc, фоном и жестом — без запроса', async ({
  page,
  isMobile,
}) => {
  test.setTimeout(120_000)
  const calls = trackPersonalRequests(page)
  await openApp(page)
  const sheet = consentSheet(page)

  // The keyboard opens the sheet over the first screen instead of sending anything.
  await helloText(page).click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Перед началом' })).toBeVisible()
  await expect(sheet.getByTestId('data-consent')).toContainText('Мне есть 18 лет')
  await expect(sheet.getByTestId('data-consent')).toContainText('на запоминание важного из них')
  const toggle = sheet.getByTestId('data-consent-toggle')
  await expect(toggle).not.toBeChecked()
  await expect(sheet.getByTestId('consent-continue'), '«Продолжить» неактивна до отметки').toHaveClass(
    /disabled/,
  )
  await expect(sheet.getByTestId('guest-note'), 'сроки хранения под кнопками').toContainText('30 дней')
  await step(
    page,
    'app-consent-open',
    'Лист согласия поверх первого экрана: снятый флажок, «Продолжить» неактивна, сроки хранения под кнопками',
  )
  expect(calls, 'открытие листа ничего не отправило').toEqual([])

  // The tick arms «Продолжить», and only the tick.
  await toggle.check()
  await expect(sheet.getByTestId('consent-continue')).not.toHaveClass(/disabled/)
  await toggle.uncheck()
  await expect(sheet.getByTestId('consent-continue')).toHaveClass(/disabled/)

  // A document opens without losing the sheet or the tick.
  const consentPagePromise = page.waitForEvent('popup')
  await sheet.getByRole('link', { name: 'согласие на обработку персональных данных', exact: true }).click()
  const consentPage = await consentPagePromise
  await consentPage.waitForLoadState('domcontentloaded')
  await expect(consentPage).toHaveURL(/\/consent$/)
  await consentPage.close()
  await expect(toggle, 'открытие документа не сбросило отметку').not.toBeChecked()
  await toggle.check()

  // Closing by the button: the first screen and no request.
  await sheet.getByTestId('consent-close').click()
  await expect(sheet).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  expect(calls, 'закрытие кнопкой ничего не отправило').toEqual([])

  // The button «Поговорить»; closing by Escape.
  await helloVoice(page).click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await expect(sheet.getByTestId('data-consent-toggle'), 'отметка пережила закрытие').toBeChecked()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // The sphere opens the same sheet; a tap on the backdrop closes it.
  await firstHello(page).locator('.rd-first-hello-stage').click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  const width = page.viewportSize()!.width
  await page.locator('.sheet-backdrop').click({ position: { x: Math.floor(width / 2), y: 20 } })
  await expect(sheet).toHaveCount(0)

  // And the swipe-down gesture.
  await helloVoice(page).click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  // modal-in appears before the opening transition; its initial coordinates can still be offscreen.
  await expect(sheet).toHaveCSS('transform', /^(?:none|matrix\(1, 0, 0, 1, 0, 0\))$/)
  const box = (await sheet.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 12
  if (isMobile) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + (388 * step) / 12 }],
      })
      await page.waitForTimeout(30)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + 388, { steps: 12 })
    await page.mouse.up()
  }
  await expect(sheet).toHaveCount(0)
  await step(page, 'app-consent-closed', 'Лист закрыт жестом вниз: человек на первом экране, запроса не было')

  expect(calls, 'ни одно закрытие ничего не отправило').toEqual([])
  expect(await storedDevice(page), 'аккаунт так и не создан').toBeNull()
})

// `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия» («Начало
// текстом»): the keyboard opens the text view with an empty box, nothing is typed on the first screen.
test('лист согласия: «Продолжить» продолжает старт с клавиатуры — аккаунт, память, текстовый вид с пустым полем, без микрофона', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const session = trackSession(page)
  await openApp(page)

  await helloText(page).click()
  const sheet = consentSheet(page)
  await sheet.getByTestId('data-consent-toggle').check()
  await sheet.getByTestId('consent-continue').click()

  // The chain ran by itself: account, consents, the conversation in its text view with an empty box.
  const current = page.locator('.page-current')
  await expect(current.locator('.message-received').first()).toContainText('Я рядом. С чего начнём?', {
    timeout: 30_000,
  })
  const input = current.getByPlaceholder('Напиши, что происходит')
  await expect(input).toBeVisible()
  await expect(input, 'поле пустое: на первом экране ничего не набирали').toHaveValue('')
  await expect(current.locator('.message-sent'), 'сообщений человека ещё нет').toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'прослушивание не началось',
  ).toHaveCount(0)
  expect(await spokenBy(page), 'свой голос не включался').toEqual([])
  expect(await playedBy(page), 'агент в тексте не звучит').toBe(0)
  await expect(sheet, 'лист не открылся повторно').toHaveCount(0)
  await step(
    page,
    'app-consent-text-start',
    'После отметки и «Продолжить» разговор открыт текстом: приветствие и пустое поле ввода',
  )

  const accountId = session.userId()
  expect(await storedDevice(page), 'удостоверение устройства сохранено').not.toBeNull()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email: null,
    consentsCompleted: true,
    consentVersion: POLICY_VERSION,
  })

  // The first words are typed in the conversation itself and go out once.
  const FIRST = 'Мне тревожно, не могу уснуть'
  await input.fill(FIRST)
  await page.getByRole('button', { name: 'Отправить' }).click()
  const sent = current.locator('.message-sent').filter({ hasText: FIRST })
  await expect(sent).toHaveCount(1, { timeout: 20_000 })
  await expect(current.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await expect(sent, 'сообщение не ушло дважды').toHaveCount(1)

  // Back on the signed-in home: «Начать разговор», no first screen and no box.
  await current.locator('.navbar a.back').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  await expect(firstHello(page)).toHaveCount(0)
  await expect(page.locator('.page-current textarea')).toHaveCount(0)
})

// `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии» («Окно согласия при голосовом
// старте», «Подтверждение продолжает исходное действие»).
test('лист согласия: «Продолжить» продолжает голосовой старт, в том числе от нажатия на шар', async ({
  page,
}) => {
  test.setTimeout(120_000)
  trackSession(page)
  await openApp(page)

  await firstHello(page).locator('.rd-first-hello-stage').click()
  const sheet = consentSheet(page)
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await sheet.getByTestId('data-consent-toggle').check()
  await sheet.getByTestId('consent-continue').click()

  // The original intention was voice: the sphere listens after the greeting, as a plain start does.
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({
    timeout: 30_000,
  })
  const caption = page.getByTestId('voice-caption')
  await expect(caption).not.toBeEmpty({ timeout: 30_000 })
  expect(await playedBy(page), 'приветствие агента сыграно').toBeGreaterThan(5)
  await expect(sheet, 'лист не открылся повторно').toHaveCount(0)
  await step(
    page,
    'app-consent-voice-start',
    'Голосовой старт после согласия: разговор слушает, агент здоровается голосом',
  )
})

// `openspec/changes/rework-web-first-screen`, «Сбой начала»: the error stays under the buttons of the
// first screen, and the retry does not ask for the agreements again.
test('лист согласия: ошибка после подтверждения — сообщение на первом экране, лист не открывается повторно', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const calls = trackPersonalRequests(page)
  await openApp(page)
  const first = page.locator('.page-current')
  const sheet = consentSheet(page)

  // The account creation fails: the chain after «Продолжить» breaks at its first step.
  await page.route('**/api/auth/device', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  )
  await helloText(page).click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await sheet.getByTestId('data-consent-toggle').check()
  await sheet.getByTestId('consent-continue').click()

  await expect(first.getByTestId('form-error')).toContainText('Попробуй', { timeout: 30_000 })
  await expect(sheet, 'ошибка закрыла лист и не открыла его заново').toHaveCount(0)
  // No conversation opened, and the chain stopped at its first step: no session, no consents, no dialog.
  await expect(page.locator('.message-sent'), 'разговор не открылся').toHaveCount(0)
  await expect(firstHello(page), 'человек остаётся на первом экране').toBeVisible()
  await expect(helloVoice(page), 'кнопки снова доступны').toBeEnabled()
  expect(calls, 'цепочка упала на первом шаге: дальше входа ничего не ушло').toEqual([
    'POST /api/auth/device',
  ])
  // client-core keeps the new device identity in local storage before the server hears of it, so the
  // retry below signs in with the same identity; it is the account that was not created.
  expect(await storedDevice(page), 'ключ устройства сохранён локально для повтора').not.toBeNull()
  await step(
    page,
    'app-consent-error',
    'Цепочка после «Продолжить» упала: ошибка под кнопками первого экрана',
  )

  // The retry does not ask again: no sheet, the same error while the server is still down.
  await helloText(page).click()
  await expect(first.getByTestId('form-error')).toContainText('Попробуй', { timeout: 30_000 })
  await expect(sheet, 'повтор без листа согласия').toHaveCount(0)
  expect(calls, 'повтор — снова только попытка входа').toEqual([
    'POST /api/auth/device',
    'POST /api/auth/device',
  ])

  // And once the server is back the same press starts the conversation, in the text view as before.
  await page.unroute('**/api/auth/device')
  await helloText(page).click()
  await expect(page.locator('.page-current').getByPlaceholder('Напиши, что происходит')).toBeVisible({
    timeout: 30_000,
  })
  await step(page, 'app-consent-retry', 'Повтор после ошибки: разговор открыт текстом без повторного листа')
})

// `openspec/changes/rework-web-first-screen`, «Главная вошедшего»: «Начать текстом» opens the dialog in the
// text view with an empty box; the first message goes once, a reconnect or a second mount does not repeat it.
test('начало текстом с главной: пустое поле, одно сообщение, reconnect и возврат не дублируют его', async ({
  page,
}) => {
  test.setTimeout(150_000)
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
  await openApp(page)
  await startAnonymously(page)
  const FIRST = 'Мне тревожно и не спится'

  // The signed-in home has no box and no suggestions: only the two ways to start.
  const home = page.locator('.page-current')
  await expect(home.locator('textarea')).toHaveCount(0)
  await expect(home.getByTestId('start-suggestion')).toHaveCount(0)
  await expect(homeStartVoice(page)).toHaveText('Начать разговор')
  await expect(homeStartText(page)).toHaveAccessibleName('Начать текстом')
  await step(
    page,
    'app-home-signed',
    'Главная вошедшего: «Начать разговор» и клавиатура, без поля и подсказок',
  )
  await homeStartText(page).click()

  const current = page.locator('.page-current')
  const greeting = current.locator('.message-received').first()
  await expect(greeting).toContainText('Я рядом. С чего начнём?', { timeout: 30_000 })
  const input = current.getByPlaceholder('Напиши, что происходит')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'микрофон сам не включился',
  ).toHaveCount(0)
  expect(await spokenBy(page), 'свой голос не включался').toEqual([])
  expect(await playedBy(page), 'агент в тексте не звучит').toBe(0)
  await step(page, 'app-text-start', 'Текстовый старт: приветствие агента и пустое поле ввода')

  await input.fill(FIRST)
  await page.getByRole('button', { name: 'Отправить' }).click()
  const sent = current.locator('.message-sent').filter({ hasText: FIRST })
  await expect(sent).toHaveCount(1, { timeout: 20_000 })
  expect((await sent.boundingBox())!.y, 'сообщение под приветствием').toBeGreaterThan(
    (await greeting.boundingBox())!.y,
  )
  await expect(current.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await expect(sent, 'сообщение не ушло дважды').toHaveCount(1)

  // A dropped connection comes back by itself; the acknowledged text is not sent again.
  const socketsBefore = await page.evaluate(
    () => (window as unknown as { __sockets: WebSocket[] }).__sockets.length,
  )
  await page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1)?.close())
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const sockets = (window as unknown as { __sockets: WebSocket[] }).__sockets
          return sockets.at(-1)?.readyState === WebSocket.OPEN ? sockets.length : 0
        }),
      { timeout: 30_000, message: 'соединение переподключилось' },
    )
    .toBeGreaterThan(socketsBefore)
  await expect(sent, 'reconnect не создал дубль').toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'микрофон и тут не включился',
  ).toHaveCount(0)
  await step(page, 'app-text-reconnect', 'После обрыва и переподключения первое сообщение одно')

  // Leaving and coming back over the unfinished-conversation question does not duplicate it either.
  await current.locator('.navbar a.back').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  await homeStartVoice(page).click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByTestId('resume-sheet')).toBeVisible()
  await sheet.getByTestId('resume-continue').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  await expect(
    page.locator('.page-current .message-sent').filter({ hasText: FIRST }),
    'повторный вход в разговор не создал дубль',
  ).toHaveCount(1)
  await step(page, 'app-text-remount', 'Возврат в разговор: первое сообщение по-прежнему одно')
})

// `openspec/changes/add-fast-dialog-start`, dialog «Начало разговора с главного экрана» («(PWA,
// Telegram) Продолжение или новый разговор сохраняет намерение»): the question is asked before a new
// start, and both answers keep what the person pressed, the voice or the keyboard.
test('вопрос о незавершённом разговоре: «Продолжить» и «Завершить и начать новый» сохраняют голосовое и текстовое намерение', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openApp(page)
  await startAnonymously(page)

  // Something said earlier: an unfinished conversation with a message, already opened once in this
  // session. Going back without a reload keeps it that way, so the start below re-enters the same dialog.
  await homeStartText(page).click()
  const started = page.locator('.page-current')
  await started.getByPlaceholder('Напиши, что происходит').fill('Проверка связи')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(started.locator('.message-sent').first()).toBeVisible({ timeout: 30_000 })
  await expect(started.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await started.locator('.navbar a.back').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })

  // The keyboard finds it and asks first; «Продолжить» opens the same conversation in the text view,
  // with an empty box and without listening.
  await homeStartText(page).click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByTestId('resume-sheet')).toBeVisible()
  await expect(sheet).toContainText('Есть незавершённый разговор')
  await step(
    page,
    'app-resume-ask',
    'Старт с клавиатуры нашёл незавершённый разговор: вопрос «Продолжить или начать новый»',
  )
  await sheet.getByTestId('resume-continue').click()
  let current = page.locator('.page-current')
  await expect(current.locator('.message-sent').filter({ hasText: 'Проверка связи' })).toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(current.getByPlaceholder('Напиши, что происходит')).toHaveValue('')
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'без автоматического прослушивания',
  ).toHaveCount(0)
  expect(await spokenBy(page), 'свой голос не включался').toEqual([])
  await step(page, 'app-resume-continue', '«Продолжить»: тот же разговор в текстовом виде, поле пустое')

  // «Завершить и начать новый» from the keyboard: a new conversation in the text view.
  await current.locator('.navbar a.back').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  await homeStartText(page).click()
  await expect(sheet.getByTestId('resume-sheet')).toBeVisible()
  await sheet.getByTestId('resume-new').click()
  current = page.locator('.page-current')
  await expect(current.locator('.message-received').first()).toContainText('Я рядом. С чего начнём?', {
    timeout: 30_000,
  })
  await expect(current.getByPlaceholder('Напиши, что происходит')).toBeVisible()
  await expect(
    current.locator('.message-sent').filter({ hasText: 'Проверка связи' }),
    'это новый разговор',
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'без автоматического прослушивания',
  ).toHaveCount(0)
  await step(page, 'app-resume-new', '«Завершить и начать новый»: новый разговор в текстовом виде')

  // The voice intent survives the question too. The new conversation has no message yet, so it is
  // finished and replaced by one more start: say something first to keep it unfinished.
  await current.getByPlaceholder('Напиши, что происходит').fill('Ещё одна проверка')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(current.locator('.message-sent').first()).toBeVisible({ timeout: 20_000 })
  await current.locator('.navbar a.back').click()
  await expect(button(page, 'Начать разговор')).toBeVisible({ timeout: 30_000 })
  await homeStartVoice(page).click()
  await expect(sheet.getByTestId('resume-sheet')).toBeVisible()
  await sheet.getByTestId('resume-continue').click()
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'голосовое намерение сохранено',
  ).toBeVisible({
    timeout: 30_000,
  })
})

// `openspec/changes/add-fast-dialog-start`, dialog «Начало разговора с главного экрана» («(PWA,
// Telegram) Старт не удался») и «Главный экран мобильного клиента» («Ошибка запуска»).
test('старт не удался: ошибка показана на главной, кнопки снова доступны, повтор открывает разговор', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openApp(page)
  await startAnonymously(page)

  await page.route('**/api/dialogs', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      : route.fallback(),
  )
  const home = page.locator('.page-current')
  await homeStartText(page).click()
  await expect(home.getByTestId('form-error')).toContainText('Попробуй', { timeout: 30_000 })
  await expect(homeStartVoice(page), 'кнопка снова доступна').toBeEnabled()
  await expect(homeStartText(page)).toBeEnabled()
  await step(page, 'app-start-error', 'Старт не удался: ошибка под кнопками главной')

  await page.unroute('**/api/dialogs')
  await homeStartText(page).click()
  await expect(page.locator('.page-current').getByPlaceholder('Напиши, что происходит')).toBeVisible({
    timeout: 30_000,
  })
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: «Дневное
// оформление», «Ночное оформление».
test('тема по местному времени: днём светлая, ночью тёмная, выставляется до первой отрисовки', async ({
  page,
}) => {
  // The boot script runs before any bundle: with the app scripts blocked its marks are still there.
  await page.route('**/*.js', (route) => route.abort())
  await page.clock.install({ time: new Date(DAY) })
  await page.goto(`${PWA_URL}/`)
  await page.waitForLoadState('load')
  expectLightTheme(await themeState(page))
  await page.unroute('**/*.js')

  await openApp(page)
  expectLightTheme(await themeState(page))
  const switcher = page.locator('.page-current').getByTestId('theme-switch')
  await expect(switcher).toHaveAttribute('role', 'switch')
  await expect(switcher).toHaveAttribute('aria-checked', 'false')
  await expect(switcher).toHaveAccessibleName('Включить тёмную тему')
  await step(page, 'app-theme-day', 'Днём главная светлая до первой отрисовки, без мигания')

  await page.clock.setFixedTime(new Date(NIGHT))
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  expectDarkTheme(await themeState(page))
  await expect(switcher).toHaveAttribute('aria-checked', 'true')
  await expect(switcher).toHaveAccessibleName('Включить светлую тему')
  await step(page, 'app-theme-night', 'Ночью главная тёмная: переключатель показывает полумесяц')
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление» («Светлая тема
// системы»): the OS palette is never read.
test('тема: системная палитра устройства не влияет на выбор', async ({ page }) => {
  await page.clock.install({ time: new Date(NIGHT) })
  await page.emulateMedia({ colorScheme: 'light' })
  await openApp(page)
  expectDarkTheme(await themeState(page))

  await page.clock.setFixedTime(new Date(DAY))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  expectLightTheme(await themeState(page))
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление» («Ручное
// переключение»).
test('тема: переключатель — нажатие, клавиатура и свайп, зона 44×44, без запроса', async ({ page }) => {
  await page.clock.install({ time: new Date(DAY) })
  const calls = trackPersonalRequests(page)
  await openApp(page)
  const home = page.locator('.page-current')
  const switcher = home.getByTestId('theme-switch')
  await expect(switcher).toBeVisible()

  const zone = await switcher.boundingBox()
  expect(zone).not.toBeNull()
  expect(zone!.width, 'зона нажатия по ширине').toBeGreaterThanOrEqual(44)
  expect(zone!.height, 'зона нажатия по высоте').toBeGreaterThanOrEqual(44)

  await switcher.click()
  const tapped = await themeState(page)
  expectDarkTheme(tapped)
  expect(tapped.manualChoice, 'выбор сохранён на устройстве').toBe('dark')
  await expect(switcher).toHaveAttribute('aria-checked', 'true')
  await expect(switcher).toHaveAccessibleName('Включить светлую тему')
  await step(page, 'app-theme-tap', 'Нажатие переключателя сразу включило тёмную тему')

  await switcher.focus()
  await page.keyboard.press('Enter')
  expectLightTheme(await themeState(page))
  await expect(switcher).toHaveAttribute('aria-checked', 'false')

  // A horizontal drag across the pill is a swipe asking for the side it points to: right is night.
  const pill = (await switcher.boundingBox())!
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2)
  await page.mouse.down()
  await page.mouse.move(pill.x + pill.width / 2 + 40, pill.y + pill.height / 2, { steps: 5 })
  await page.mouse.up()
  expectDarkTheme(await themeState(page))
  await step(page, 'app-theme-swipe', 'Свайп по переключателю снова включил тёмную тему')

  expect(calls, 'переключение темы не отправляет запрос').toEqual([])
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: «Смена темы без
// перезагрузки», «Ручной выбор сохраняется».
test('тема: граница без перезагрузки; ручной выбор сохраняется и важнее расписания', async ({ page }) => {
  await page.clock.install({ time: new Date(BEFORE_DARK_BOUNDARY) })
  await openApp(page)
  expectLightTheme(await themeState(page))

  // Ten seconds later the schedule flips at 22:00 and the open client follows without a reload.
  await page.clock.runFor(20_000)
  await expect.poll(async () => (await themeState(page)).colorScheme).toBe('dark')
  expectDarkTheme(await themeState(page))
  await expect(helloVoice(page), 'первый экран на месте после смены темы').toBeVisible()
  await step(page, 'app-theme-boundary', 'После 22:00 открытая главная сама стала тёмной')

  // A manual choice wins over the schedule: the 07:00 boundary does not reset it.
  await page.locator('.page-current').getByTestId('theme-switch').click()
  expectLightTheme(await themeState(page))
  await page.clock.setFixedTime(new Date(BEFORE_LIGHT_BOUNDARY_NEXT_DAY))
  await page.clock.runFor(10_000)
  const afterBoundary = await themeState(page)
  expectLightTheme(afterBoundary)
  expect(afterBoundary.manualChoice).toBe('light')

  // And it survives a reload: at 06:59 the schedule would say dark, the stored choice says light.
  await page.reload()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  const reloaded = await themeState(page)
  expectLightTheme(reloaded)
  expect(reloaded.manualChoice).toBe('light')
  await step(
    page,
    'app-theme-manual-persist',
    'Ручной выбор пережил границу 07:00 и перезагрузку: светлая осталась',
  )
})
