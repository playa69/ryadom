import type { Locator, Page } from '@playwright/test'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { PWA_URL } from '../playwright.config'
import {
  button,
  consentSheet,
  expectNoHorizontalOverflow,
  openApp,
  openConversationSettings,
  startAnonymously,
} from '../support/app'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'
import { playedBy, spokenBy } from '../support/speech'
import { profileOf, storedDevice, trackSession } from '../support/session'

/**
 * The PWA home after `openspec/changes/add-fast-dialog-start`: a new person lands on it directly
 * (no consent gate), the first-message field with the suggestions and the theme switch work
 * locally, and the first text or voice start opens the consent sheet over home instead of sending
 * anything. Plus the start itself: a typed message opens the conversation in its text view, goes
 * out exactly once (a reconnect or a second mount does not duplicate it), and the question about
 * an unfinished conversation keeps the text-or-voice intention.
 *
 * The Telegram Mini App is the same code on home; its specifics (the Telegram account) live in
 * app-telegram.spec.ts. The native shell is not covered here: Playwright runs the web build, where
 * `isNative()` is false, so the kept native branch (the gate, voice-only start, dark-only palette)
 * is fixed by the unit tests of consent-gate and the composer instead.
 */

// The suggestion wordings live in packages/client-core/src/dialog-start.ts and are pinned here on
// purpose: a drift between the surfaces must show up as a red test.
const SUGGESTIONS = ['Хочу выговориться', 'Мне тревожно', 'Просто поговорить'] as const

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

// `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии» («Главная доступна до
// согласия») и account-auth «Первый экран: разговор с первого действия» («Что видит новый человек»,
// «Ввод и подсказка без запроса»).
test('главная нового человека: поле, подсказки и тема сразу, без ворота и без запросов', async ({ page }) => {
  const calls = trackPersonalRequests(page)
  await openApp(page)

  const home = page.locator('.page-current')
  await expect(button(page, 'Поговорить')).toBeVisible()
  await expect(home.getByTestId('welcome-talk'), 'прежнего входного ворота нет').toHaveCount(0)
  // The mandatory tick lives only in the consent sheet now, not on home.
  await expect(home.getByTestId('data-consent-toggle')).not.toBeVisible()
  await expect(home.getByTestId('start-draft')).toBeVisible()
  await expect(home.getByTestId('start-suggestion')).toHaveText(SUGGESTIONS)
  await expect(home.getByTestId('theme-switch')).toBeVisible()
  await expect(home.getByTestId('have-account')).toHaveText('Войти')
  await expect(page.locator('.rd-sos-button')).toBeVisible()
  await expect(home.getByTestId('consent-notice')).toContainText('ИИ для самоподдержки')
  await expect(home.getByText('В опасной ситуации звони 112.')).toBeVisible()
  expect(await storedDevice(page), 'до согласия удостоверения нет').toBeNull()
  await step(
    page,
    'app-home-first',
    'Главная нового человека: поле первого сообщения, подсказки и «Поговорить» сразу, ворота нет',
  )

  // Typing flips the main action to «Отправить»; whitespace alone does not.
  const draft = home.getByTestId('start-draft')
  await draft.fill('Сегодня был долгий день')
  await expect(button(page, 'Отправить')).toBeVisible()
  await draft.fill('   ')
  await expect(button(page, 'Поговорить')).toBeVisible()

  // A suggestion only fills the field in, and the text stays editable.
  await home.getByTestId('start-suggestion').nth(1).click()
  await expect(draft).toHaveValue('Мне тревожно')
  await draft.fill('Мне тревожно и не спится')
  await expect(button(page, 'Отправить')).toBeVisible()
  await step(
    page,
    'app-home-suggestion',
    'Подсказка подставила редактируемый черновик, кнопка стала «Отправить» — без запроса',
  )

  // The theme switch is local too.
  const themeBefore = (await themeState(page)).dataTheme
  await home.getByTestId('theme-switch').click()
  expect((await themeState(page)).dataTheme, 'тема переключилась').not.toBe(themeBefore)
  await expect(draft, 'переключение темы не тронуло черновик').toHaveValue('Мне тревожно и не спится')

  expect(calls, 'ввод, подсказка и тема не создают аккаунт, разговор или запрос').toEqual([])
  expect(await storedDevice(page), 'аккаунт так и не создан').toBeNull()
})

// `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента» («(PWA, Telegram)
// Подсказки — одна прокручиваемая лента»).
test('подсказки — одна прокручиваемая лента чипов на 390, доступная с клавиатуры', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)

  const home = page.locator('.page-current')
  const strip = page.getByRole('group', { name: 'Подсказки первого сообщения' })
  const chips = home.getByTestId('start-suggestion')
  await expect(chips).toHaveText(SUGGESTIONS)
  await expect(strip).toHaveAttribute('tabindex', '0')

  // One row of content-wide chips: all three share the strip's line, none wraps below.
  const stripBox = (await strip.boundingBox())!
  const chipBoxes = []
  for (let index = 0; index < 3; index += 1) chipBoxes.push((await chips.nth(index).boundingBox())!)
  for (const box of chipBoxes)
    expect(Math.abs(box.y - chipBoxes[0]!.y), 'чипы в одной строке').toBeLessThanOrEqual(2)
  expect(stripBox.height, 'лента не переносится на несколько строк').toBeLessThan(chipBoxes[0]!.height + 24)
  // Compact chips, not full-width buttons.
  for (const box of chipBoxes)
    expect(box.width, 'чип по ширине содержимого').toBeLessThan(stripBox.width - 40)

  // The strip overflows at 390 and scrolls on its own; the page does not.
  const room = await strip.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(room, 'на 390 лента прокручивается').toBeGreaterThan(10)
  await expectNoHorizontalOverflow(page)

  // The keyboard reaches every chip: the strip is focusable and End scrolls it to the last one.
  await strip.focus()
  await page.keyboard.press('End')
  await expect
    .poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
    .toBeLessThanOrEqual(1)
  await expect(chips.nth(2)).toBeInViewport()
  await step(
    page,
    'app-chips-strip',
    'Одна прокручиваемая лента чипов: с клавиатуры докручена до «Просто поговорить»',
  )

  // And every chip is a working suggestion.
  for (const suggestion of SUGGESTIONS) {
    await chips.filter({ hasText: suggestion }).click()
    await expect(home.getByTestId('start-draft')).toHaveValue(suggestion)
  }
})

// `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента» («(PWA, Telegram)
// Поле ограничивает черновик»).
test('поле первого сообщения: не больше 4000 знаков, одни пробелы — не текст', async ({ page }) => {
  test.setTimeout(120_000)
  await openApp(page)

  const home = page.locator('.page-current')
  const draft = home.getByTestId('start-draft')
  await expect(draft).toHaveAttribute('maxlength', String(InputLimit.MessageMax))

  // Fill the allowed length at once, then type past it: the limit cuts the tail off without
  // thousands of slow controlled-input round trips through the browser driver.
  await draft.fill('а'.repeat(InputLimit.MessageMax))
  await draft.pressSequentially('а'.repeat(100))
  expect(await draft.evaluate((el: HTMLTextAreaElement) => el.value.length)).toBe(InputLimit.MessageMax)
  await expect(button(page, 'Отправить')).toBeVisible()
  await step(page, 'app-draft-limit', 'Поле приняло 4000 знаков и обрезало остальное')

  await draft.fill('     ')
  await expect(button(page, 'Поговорить'), 'пробелы не меняют кнопку').toBeVisible()
})

// `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента» («(PWA, Telegram)
// Настроить разговор свёрнуто»).
test('«Настроить разговор» свёрнуто по умолчанию, внутри — прежний выбор памяти', async ({ page }) => {
  await openApp(page)
  await startAnonymously(page)

  const home = page.locator('.page-current')
  const settings = home.getByTestId('home-settings')
  await expect(settings).toBeVisible({ timeout: 20_000 })
  expect(await settings.getAttribute('open'), 'по умолчанию свёрнуто').toBeNull()
  await expect(home.getByTestId('memory-switch'), 'выбор памяти скрыт внутри').not.toBeVisible()
  await expect(button(page, 'Поговорить')).toBeVisible()
  await step(
    page,
    'app-settings-collapsed',
    '«Настроить разговор» свёрнуто и не конкурирует с полем и кнопкой',
  )

  await openConversationSettings(page)
  const choice = home.getByTestId('memory-switch')
  await expect(choice).toBeVisible()
  await expect(choice).toContainText('Запоминать важное')
  await expect(choice).toContainText('Чтобы не начинать каждый раз с нуля')
  await step(page, 'app-settings-open', 'Внутри раскрытого блока — прежний выбор памяти')
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

// `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии»: «Окно согласия при
// отправке текста», «Окно согласия при голосовом старте», ««Продолжить» неактивна до отметки»,
// «Закрытие сохраняет черновик и намерение», «Документы из окна согласия».
test('лист согласия: открытие при старте, отметка, закрытие кнопкой, Esc, фоном и жестом — без запроса', async ({
  page,
  isMobile,
}) => {
  test.setTimeout(120_000)
  const calls = trackPersonalRequests(page)
  await openApp(page)
  const home = page.locator('.page-current')
  const draft = home.getByTestId('start-draft')
  const sheet = consentSheet(page)
  const DRAFT = 'Сегодня был трудный день'

  // A text start without a recorded consent opens the sheet over home instead of sending anything.
  await draft.fill(DRAFT)
  await button(page, 'Отправить').click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Перед началом' })).toBeVisible()
  await expect(sheet.getByTestId('data-consent')).toContainText('Мне есть 18 лет')
  const toggle = sheet.getByTestId('data-consent-toggle')
  await expect(toggle).not.toBeChecked()
  await expect(sheet.getByTestId('consent-continue'), '«Продолжить» неактивна до отметки').toHaveClass(
    /disabled/,
  )
  await expect(draft, 'черновик остаётся за листом').toHaveValue(DRAFT)
  await step(
    page,
    'app-consent-open',
    'Лист согласия поверх главной: снятый флажок, «Продолжить» неактивна, за листом черновик',
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

  // Closing by the button: home, the draft and no request.
  await sheet.getByTestId('consent-close').click()
  await expect(sheet).toHaveCount(0)
  await expect(draft).toHaveValue(DRAFT)
  expect(calls, 'закрытие кнопкой ничего не отправило').toEqual([])

  // Closing by Escape.
  await button(page, 'Отправить').click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(draft).toHaveValue(DRAFT)

  // A voice start opens the same sheet; a tap on the backdrop closes it.
  await draft.fill('')
  await button(page, 'Поговорить').click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await expect(sheet.getByTestId('data-consent-toggle'), 'отметка пережила закрытия').toBeChecked()
  const width = page.viewportSize()!.width
  await page.locator('.sheet-backdrop').click({ position: { x: Math.floor(width / 2), y: 20 } })
  await expect(sheet).toHaveCount(0)

  // And the swipe-down gesture.
  await button(page, 'Поговорить').click()
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
  await step(page, 'app-consent-closed', 'Лист закрыт жестом вниз: человек на главной, запроса не было')

  expect(calls, 'ни одно закрытие ничего не отправило').toEqual([])
  expect(await storedDevice(page), 'аккаунт так и не создан').toBeNull()
})

// `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии» («Подтверждение
// продолжает исходное действие»), dialog «Начало разговора с главного экрана» («(Web, PWA,
// Telegram) Подтверждение согласия продолжает старт»), account-auth («(PWA, Telegram) Начало
// текстом»).
test('лист согласия: «Продолжить» продолжает текстовый старт — аккаунт, один текст, без микрофона', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const session = trackSession(page)
  await openApp(page)
  const FIRST = 'Мне тревожно, не могу уснуть'

  await page.locator('.page-current').getByTestId('start-draft').fill(FIRST)
  await button(page, 'Отправить').click()
  const sheet = consentSheet(page)
  await sheet.getByTestId('data-consent-toggle').check()
  await sheet.getByTestId('consent-continue').click()

  // The chain ran by itself: account, consents, the conversation in its text view.
  const current = page.locator('.page-current')
  const greeting = current.locator('.message-received').first()
  const sent = current.locator('.message-sent').filter({ hasText: FIRST })
  await expect(greeting).toContainText('Я рядом. С чего начнём?', { timeout: 30_000 })
  await expect(sent).toHaveCount(1)
  await expect(sent).toBeVisible()
  // The text shows at once, under the greeting, before the connection is ready.
  expect((await sent.boundingBox())!.y, 'первое сообщение под приветствием').toBeGreaterThan(
    (await greeting.boundingBox())!.y,
  )
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
    'После отметки и «Продолжить» разговор открыт текстом: приветствие, под ним набранная фраза',
  )

  const accountId = session.userId()
  expect(await storedDevice(page), 'удостоверение устройства сохранено').not.toBeNull()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email: null,
    consentsCompleted: true,
    consentVersion: POLICY_VERSION,
  })
  // The reply lands as usual, and the first message is not repeated.
  await expect(current.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await expect(sent, 'сообщение не ушло дважды').toHaveCount(1)

  // Back on home the field starts empty again: the text now lives in the conversation.
  await current.locator('.navbar a.back').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.page-current').getByTestId('start-draft')).toHaveValue('')
})

// `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии» («Окно согласия при
// голосовом старте», «Подтверждение продолжает исходное действие»).
test('лист согласия: «Продолжить» продолжает голосовой старт', async ({ page }) => {
  test.setTimeout(120_000)
  trackSession(page)
  await openApp(page)

  await button(page, 'Поговорить').click()
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

// `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии» («Ошибка после
// подтверждения») и account-auth «Первый экран: разговор с первого действия» («Сбой начала»).
test('лист согласия: ошибка после подтверждения — черновик на месте, лист не открывается повторно', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const calls = trackPersonalRequests(page)
  await openApp(page)
  const home = page.locator('.page-current')
  const draft = home.getByTestId('start-draft')
  const sheet = consentSheet(page)
  const FIRST = 'Хочу рассказать, как прошёл день'

  // The account creation fails: the chain after «Продолжить» breaks at its first step.
  await page.route('**/api/auth/device', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  )
  await draft.fill(FIRST)
  await button(page, 'Отправить').click()
  await expect(sheet.getByTestId('consent-sheet')).toBeVisible()
  await sheet.getByTestId('data-consent-toggle').check()
  await sheet.getByTestId('consent-continue').click()

  await expect(home.getByTestId('form-error')).toContainText('Попробуй', { timeout: 30_000 })
  await expect(sheet, 'ошибка закрыла лист и не открыла его заново').toHaveCount(0)
  await expect(draft, 'черновик сохранён').toHaveValue(FIRST)
  // No conversation opened, and the chain stopped at its first step: no session, no consents, no dialog.
  await expect(page.locator('.message-sent'), 'разговор не открылся').toHaveCount(0)
  await expect(home.getByTestId('start-composer'), 'человек остаётся на главной').toBeVisible()
  expect(calls, 'цепочка упала на первом шаге: дальше входа ничего не ушло').toEqual([
    'POST /api/auth/device',
  ])
  // client-core keeps the new device identity in local storage before the server hears of it, so the
  // retry below signs in with the same identity; it is the account that was not created.
  expect(await storedDevice(page), 'ключ устройства сохранён локально для повтора').not.toBeNull()
  await step(
    page,
    'app-consent-error',
    'Цепочка после «Продолжить» упала: ошибка на главной, черновик на месте',
  )

  // The retry does not ask again: no sheet, the same error while the server is still down.
  await button(page, 'Отправить').click()
  await expect(home.getByTestId('form-error')).toContainText('Попробуй', { timeout: 30_000 })
  await expect(sheet, 'повтор без листа согласия').toHaveCount(0)
  await expect(draft).toHaveValue(FIRST)
  expect(calls, 'повтор — снова только попытка входа').toEqual([
    'POST /api/auth/device',
    'POST /api/auth/device',
  ])

  // And once the server is back the same press starts the conversation with the same text.
  await page.unroute('**/api/auth/device')
  await button(page, 'Отправить').click()
  const sent = page.locator('.page-current .message-sent').filter({ hasText: FIRST })
  await expect(sent).toBeVisible({ timeout: 30_000 })
  await expect(sent).toHaveCount(1)
  await step(page, 'app-consent-retry', 'Повтор после ошибки: разговор открыт текстом без повторного листа')
})

// `openspec/changes/add-fast-dialog-start`, dialog «Начало разговора с главного экрана» («(PWA,
// Telegram) Набранный текст», «(PWA, Telegram) Текст с главной уходит один раз»).
test('начало текстом с главной: сообщение под приветствием сразу, reconnect и возврат не дублируют его', async ({
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

  const draft = page.locator('.page-current').getByTestId('start-draft')
  await draft.fill(FIRST)
  await button(page, 'Отправить').click()

  const current = page.locator('.page-current')
  const greeting = current.locator('.message-received').first()
  const sent = current.locator('.message-sent').filter({ hasText: FIRST })
  await expect(greeting).toContainText('Я рядом. С чего начнём?', { timeout: 30_000 })
  // The typed message is on screen at once, under the greeting, while it is still being delivered.
  await expect(sent).toHaveCount(1)
  expect((await sent.boundingBox())!.y, 'первое сообщение под приветствием').toBeGreaterThan(
    (await greeting.boundingBox())!.y,
  )
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'микрофон сам не включился',
  ).toHaveCount(0)
  expect(await spokenBy(page), 'свой голос не включался').toEqual([])
  expect(await playedBy(page), 'агент в тексте не звучит').toBe(0)
  await step(
    page,
    'app-text-start',
    'Текстовый старт: приветствие агента, под ним набранная фраза первым сообщением',
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
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.page-current').getByTestId('start-draft'), 'поле снова пусто').toHaveValue('')
  await button(page, 'Поговорить').click()
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
// Telegram) Продолжение или новый разговор сохраняет намерение»).
test('вопрос о незавершённом разговоре: «Продолжить» и «Завершить и начать новый» сохраняют текстовое намерение', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openApp(page)
  await startAnonymously(page)

  // Something said earlier: an unfinished conversation with a message, already opened once in this
  // session. Going back without a reload keeps it that way, so the typed start below re-enters the
  // same dialog — where a handoff consumed by dialogId would swallow the new text.
  await page.locator('.page-current').getByTestId('start-draft').fill('Проверка связи')
  await button(page, 'Отправить').click()
  const started = page.locator('.page-current')
  await expect(started.locator('.message-sent').first()).toBeVisible({ timeout: 30_000 })
  await expect(started.locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await started.locator('.navbar a.back').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })

  // A typed start finds it and asks first; «Продолжить» opens the same conversation in the text
  // view and the draft becomes its next message — once, without listening.
  const CONTINUED = 'Продолжим текстом'
  await page.locator('.page-current').getByTestId('start-draft').fill(CONTINUED)
  await button(page, 'Отправить').click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByTestId('resume-sheet')).toBeVisible()
  await expect(sheet).toContainText('Есть незавершённый разговор')
  await step(
    page,
    'app-resume-ask',
    'Набранный старт нашёл незавершённый разговор: вопрос «Продолжить или начать новый»',
  )
  await sheet.getByTestId('resume-continue').click()
  let current = page.locator('.page-current')
  await expect(current.locator('.message-sent').filter({ hasText: 'Проверка связи' })).toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(current.locator('.message-sent').filter({ hasText: CONTINUED })).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'без автоматического прослушивания',
  ).toHaveCount(0)
  expect(await spokenBy(page), 'свой голос не включался').toEqual([])
  await step(
    page,
    'app-resume-continue',
    '«Продолжить»: тот же разговор в текстовом виде, набранная фраза — следующее сообщение',
  )

  // «Завершить и начать новый»: the new conversation gets the draft as its first message instead.
  await current.locator('.navbar a.back').click()
  await expect(button(page, 'Поговорить')).toBeVisible({ timeout: 30_000 })
  const ANEW = 'Начну сначала'
  await page.locator('.page-current').getByTestId('start-draft').fill(ANEW)
  await button(page, 'Отправить').click()
  await expect(sheet.getByTestId('resume-sheet')).toBeVisible()
  await sheet.getByTestId('resume-new').click()
  current = page.locator('.page-current')
  await expect(current.locator('.message-received').first()).toContainText('Я рядом. С чего начнём?', {
    timeout: 30_000,
  })
  await expect(current.locator('.message-sent').filter({ hasText: ANEW })).toHaveCount(1)
  await expect(
    current.locator('.message-sent').filter({ hasText: 'Проверка связи' }),
    'это новый разговор',
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Остановить запись' }),
    'без автоматического прослушивания',
  ).toHaveCount(0)
  await step(
    page,
    'app-resume-new',
    '«Завершить и начать новый»: новый разговор в текстовом виде, набранная фраза — первое сообщение',
  )
})

// `openspec/changes/add-fast-dialog-start`, dialog «Начало разговора с главного экрана» («(PWA,
// Telegram) Старт не удался») и «Главный экран мобильного клиента» («Ошибка запуска»).
test('старт не удался: ошибка показана, черновик на месте, кнопка снова доступна', async ({ page }) => {
  test.setTimeout(120_000)
  await openApp(page)
  await startAnonymously(page)
  const FIRST = 'Сегодня было неспокойно'

  await page.route('**/api/dialogs', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      : route.fallback(),
  )
  const home = page.locator('.page-current')
  const draft = home.getByTestId('start-draft')
  await draft.fill(FIRST)
  await button(page, 'Отправить').click()
  await expect(home.getByTestId('form-error')).toContainText('Попробуй', { timeout: 30_000 })
  await expect(draft, 'набранный текст остаётся в поле').toHaveValue(FIRST)
  await expect(button(page, 'Отправить'), 'кнопка снова доступна').toBeEnabled()
  await expect(home.getByTestId('start-composer'), 'вкладка остаётся главной').toBeVisible()
  await step(page, 'app-start-error', 'Старт не удался: ошибка под кнопкой, черновик сохранён')

  await page.unroute('**/api/dialogs')
  await button(page, 'Отправить').click()
  const sent = page.locator('.page-current .message-sent').filter({ hasText: FIRST })
  await expect(sent).toBeVisible({ timeout: 30_000 })
  await expect(sent).toHaveCount(1)
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
test('тема: переключатель — нажатие, клавиатура и свайп, зона 44×44, без запроса и потери черновика', async ({
  page,
}) => {
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

  // The switch does not touch the draft.
  const draft = home.getByTestId('start-draft')
  await draft.fill('Проверяю тему')

  await switcher.click()
  const tapped = await themeState(page)
  expectDarkTheme(tapped)
  expect(tapped.manualChoice, 'выбор сохранён на устройстве').toBe('dark')
  await expect(switcher).toHaveAttribute('aria-checked', 'true')
  await expect(switcher).toHaveAccessibleName('Включить светлую тему')
  await expect(draft, 'черновик на месте').toHaveValue('Проверяю тему')
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
test('тема: граница без перезагрузки и потери черновика; ручной выбор сохраняется и важнее расписания', async ({
  page,
}) => {
  await page.clock.install({ time: new Date(BEFORE_DARK_BOUNDARY) })
  await openApp(page)
  expectLightTheme(await themeState(page))
  const draft = page.locator('.page-current').getByTestId('start-draft')
  await draft.fill('Черновик перед границей')

  // Ten seconds later the schedule flips at 22:00 and the open client follows without a reload.
  await page.clock.runFor(20_000)
  await expect.poll(async () => (await themeState(page)).colorScheme).toBe('dark')
  expectDarkTheme(await themeState(page))
  await expect(draft, 'черновик пережил смену темы').toHaveValue('Черновик перед границей')
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
