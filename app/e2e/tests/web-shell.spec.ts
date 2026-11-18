import type { Page } from '@playwright/test'
import { APP_URL } from '../playwright.config'
import {
  accountMenu,
  button,
  closeSidebar,
  currentTheme,
  drawer,
  expectNoHorizontalOverflow,
  expectSingleSos,
  field,
  firstHello,
  goTo,
  menuButton,
  menuItem,
  modal,
  nav,
  openAccountMenu,
  openProfile,
  openSidebar,
  openWebApp,
  pageTitle,
  registerAndConfirm,
  SIDEBAR_BREAKPOINT,
  signIn,
  sosButton,
  startAnonymously,
  startTextButton,
  startVoiceButton,
  themeSwitch,
  uniqueEmail,
  watchApiCalls,
  watchCsp,
  webUrl,
  openSignIn,
} from '../support/web'
import { clearMailbox } from '../support/mail'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'

/**
 * What the web app promises before any conversation: the security headers, the responsive frame
 * (a sidebar and a page, the way every chat app is laid out) and the layouts at the widths that
 * matter. The frame is behind the sign-in, so its tests register an account of their own.
 */

function parsePolicy(header: string): Record<string, string[]> {
  const policy: Record<string, string[]> = {}
  for (const directive of header.split(';')) {
    const [name, ...values] = directive.trim().split(/\s+/)
    if (name) policy[name] = values
  }
  return policy
}

function nonceOf(policy: Record<string, string[]>): string | undefined {
  return policy['script-src']?.find((value) => value.startsWith("'nonce-"))?.slice("'nonce-".length, -1)
}

test('страницы приходят со строгой политикой безопасности и noindex', async ({ request }) => {
  const response = await request.get(webUrl('/login'))
  expect(response.status()).toBe(200)
  const policy = parsePolicy(response.headers()['content-security-policy'] ?? '')

  // The refresh token sits in localStorage, so a script that was not issued a nonce must not run.
  const scripts = policy['script-src'] ?? []
  expect(scripts).toContain("'strict-dynamic'")
  expect(scripts).not.toContain("'unsafe-inline'")
  expect(scripts).not.toContain("'unsafe-eval'")
  expect(policy['style-src'] ?? []).not.toContain("'unsafe-inline'")
  expect(policy['frame-ancestors']).toEqual(["'none'"])
  expect(policy['object-src']).toEqual(["'none'"])
  // The browser talks to the API directly: its address (REST and WebSocket) is the only extra origin, besides
  // the two hosts of Yandex Metrika, which is not behind our proxy (it reports to mc.yandex.com).
  expect(policy['connect-src']).toEqual(
    expect.arrayContaining(["'self'", new URL(APP_URL).origin, APP_URL.replace(/^http/, 'ws')]),
  )
  const metrika = ['https://mc.yandex.ru', 'https://mc.yandex.com']
  expect(policy['connect-src']).toEqual(expect.arrayContaining(metrika))
  expect(policy['img-src']).toEqual(expect.arrayContaining(metrika))
  // The tag is inserted by our own script, which `strict-dynamic` trusts: no host is added to script-src.
  expect(scripts.filter((source) => source.includes('yandex'))).toEqual([])

  // The nonce in the header is the one the page's scripts carry, and every request gets a new one.
  const nonce = nonceOf(policy)
  expect(nonce, 'nonce в script-src').toBeTruthy()
  const html = await response.text()
  expect(html).toContain(`nonce="${nonce}"`)
  expect(html.match(/<script\b(?![^>]*\bnonce=)[^>]*>/g) ?? [], 'скрипты без nonce').toEqual([])
  const again = await request.get(webUrl('/login'))
  expect(nonceOf(parsePolicy(again.headers()['content-security-policy'] ?? ''))).not.toBe(nonce)

  // Only the landing is meant to be indexed.
  expect(response.headers()['x-robots-tag']).toContain('noindex')
  expect(html).toMatch(/<meta name="robots" content="noindex/)
})

test('проверка живости отвечает', async ({ request }) => {
  const response = await request.get(webUrl('/api/health'))
  expect(response.status()).toBe(200)
  expect((await response.json()).status).toBe('ok')
})

test('несуществующая страница отвечает 404 по-русски и укладывается в политику', async ({ page }) => {
  const violations = await watchCsp(page)
  const response = await page.goto(webUrl('/no-such-page'))
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Такой страницы нет' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'На главную' })).toBeVisible()
  expect(await violations(), 'нарушения политики безопасности').toEqual([])
})

test('экраны входа укладываются в политику, а worklet микрофона не блокируется', async ({ page }) => {
  const violations = await watchCsp(page)
  const titles: Array<[string, string]> = [
    ['/home', 'Новый разговор — Рядом'],
    ['/login', 'Вход — Рядом'],
    ['/register', 'Регистрация — Рядом'],
    ['/forgot-password', 'Восстановление пароля — Рядом'],
  ]
  for (const [path, title] of titles) {
    await openWebApp(page, path)
    // The title is set on the server per page: it is also what a screen reader announces first.
    await expect(page).toHaveTitle(title)
    expect(await violations(), `нарушения политики на ${path}`).toEqual([])
  }

  // Worklet modules are checked against script-src; 'strict-dynamic' must not shut the microphone
  // out. Loading the module is exactly what startCapture does first.
  const worklet = await page.evaluate(async () => {
    const audio = new AudioContext()
    try {
      await audio.audioWorklet.addModule('/voice-worklet.js')
      return 'loaded'
    } catch (error) {
      return String(error)
    } finally {
      await audio.close()
    }
  })
  expect(worklet).toBe('loaded')
  expect(await violations(), 'нарушения политики при загрузке worklet').toEqual([])
})

test('адаптивность: на входе, регистрации и первом экране нет горизонтальной прокрутки от 360 до 1920', async ({
  page,
}) => {
  for (const path of ['/home', '/login', '/register']) {
    await openWebApp(page, path)
    for (const width of [360, 820, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 })
      await expectNoHorizontalOverflow(page)
      // The form stays inside the window at every width, whichever way the card is laid out. The first
      // screen has no address field: its edge to hold is the plaque about the service at its foot.
      const edge = path === '/home' ? page.getByTestId('hello-plaque') : field(page, 'email')
      await expect(edge, `${path}@${width}: нижняя строка на месте`).toBeVisible()
      const box = await edge.boundingBox()
      expect(box!.x, `${path}@${width}: форма слева`).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width, `${path}@${width}: форма справа`).toBeLessThanOrEqual(width)
      await expect(
        // A newcomer meets the first screen: its start button reads «Поговорить»
        // (`openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»).
        button(page, path === '/home' ? 'Поговорить' : path === '/login' ? 'Войти' : 'Создать аккаунт'),
      ).toBeVisible()
    }
  }
})

/**
 * The signed-in frame at the widths that matter. A classic app layout: from 768px a sidebar column
 * on the left (brand, new conversation, people, history, the account at the foot) and the page
 * beside it with a centred, readable column; below that the same sidebar is a drawer behind the menu
 * button. Exactly one SOS button is on screen each time, the header's controls keep to 44px, and
 * nothing scrolls sideways.
 */
test('каркас: сайдбар слева на широком окне, шторка на телефоне, одна кнопка SOS', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-shell'))

  const brand = page.getByRole('link', { name: 'Рядом — на главную' })
  const newChat = nav(page).getByRole('link', { name: 'Новый разговор', exact: true })
  const people = nav(page).getByRole('link', { name: 'Люди рядом', exact: true })
  const noHistory = nav(page).getByText('Здесь появятся твои разговоры')
  // 768 is the last width with a column, 767 the first with a drawer.
  const layouts = [
    { width: 1920, height: 1080, walk: false },
    { width: 1280, height: 900, walk: true },
    { width: 820, height: 1100, walk: false },
    { width: 768, height: 1024, walk: false },
    { width: 767, height: 1024, walk: false },
    { width: 390, height: 844, walk: true },
    { width: 360, height: 740, walk: false },
  ] as const

  for (const { width, height, walk } of layouts) {
    const at = `${width}px`
    const persistent = width >= SIDEBAR_BREAKPOINT
    await page.setViewportSize({ width, height })
    // The relayout after a resize is a render behind: without waiting for it, the drawer's state of
    // the previous width would be read as the new width's, and «Меню» meant for the drawer would
    // fold the wide window's column into its rail instead.
    if (persistent) await expect(nav(page), `${at}: колонка собралась`).toBeVisible()
    else await expect(nav(page), `${at}: шторка собралась`).toBeHidden()
    // On a phone this is also the drawer's first check: a link to the page that is already open
    // changes no path, and the drawer still has to go.
    await goTo(page, 'Новый разговор')
    await expect(page).toHaveURL(/\/home$/)
    await expect(startVoiceButton(page)).toBeVisible()
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(pageTitle(page), `${at}: один h1`).toHaveCount(1)
    await expectSingleSos(page)
    await expectNoHorizontalOverflow(page)

    // The header: the menu button and SOS are the controls that are always there.
    const menu = (await menuButton(page).boundingBox())!
    const sos = (await sosButton(page).boundingBox())!
    for (const [name, box] of [
      ['меню', menu],
      ['SOS', sos],
    ] as const) {
      expect(box.width, `${at}: ${name}, ширина цели`).toBeGreaterThanOrEqual(44)
      expect(box.height, `${at}: ${name}, высота цели`).toBeGreaterThanOrEqual(44)
    }
    expect(sos.y + sos.height, `${at}: SOS в шапке`).toBeLessThanOrEqual(70)
    expect(sos.x, `${at}: SOS справа`).toBeGreaterThan(width / 2)
    expect(sos.x + sos.width, `${at}: SOS в окне`).toBeLessThanOrEqual(width)

    const main = (await page.getByRole('main').boundingBox())!
    // Home's column is the row of the start buttons: «Начать разговор» and the keyboard beside it
    // (`openspec/changes/rework-web-first-screen`, «Главная веб-клиента: старт голосом или текстом»).
    const voice = (await startVoiceButton(page).boundingBox())!
    const keyboard = (await startTextButton(page).boundingBox())!
    const row = { x: voice.x, width: keyboard.x + keyboard.width - voice.x }

    if (persistent) {
      await expect(drawer(page)).toHaveCount(0)
      await expect(nav(page), `${at}: сайдбар на месте`).toBeVisible()
      await expect(menuButton(page)).toBeVisible()
      // The column grows into place when the window widens (it was a drawer or a narrow rail a moment ago),
      // so its width is read once it has settled: measured mid-way it came out as the rail's 56px.
      await expect
        .poll(async () => (await nav(page).boundingBox())?.width ?? 0, { message: `${at}: сайдбар 256px` })
        .toBeGreaterThanOrEqual(240)
      const side = (await nav(page).boundingBox())!
      expect(side.x, `${at}: сайдбар у левого края`).toBeLessThanOrEqual(1)
      expect(side.width, `${at}: сайдбар 256px`).toBeGreaterThanOrEqual(240)
      expect(side.width, `${at}: сайдбар 256px`).toBeLessThanOrEqual(260)
      await expect(brand, `${at}: знак вверху`).toBeVisible()
      await expect(newChat).toBeVisible()
      await expect(people).toBeVisible()
      await expect(noHistory, `${at}: у нового аккаунта история пуста`).toBeVisible()
      await expect(nav(page).getByTestId('history-item')).toHaveCount(0)
      await expect(accountMenu(page), `${at}: аккаунт внизу`).toContainText('Тест')
      const account = (await accountMenu(page).boundingBox())!
      expect(account.y + account.height, `${at}: аккаунт у нижнего края`).toBeGreaterThanOrEqual(height - 24)
      expect(account.x + account.width, `${at}: аккаунт в колонке сайдбара`).toBeLessThanOrEqual(
        side.x + side.width + 1,
      )

      // The page is to the right of the column, and its content is a centred, readable measure.
      expect(main.x, `${at}: страница правее сайдбара`).toBeGreaterThanOrEqual(side.x + side.width - 1)
      expect(row.width, `${at}: кнопки старта не шире 448px`).toBeLessThanOrEqual(450)
      expect(row.x, `${at}: кнопки старта не липнут к сайдбару`).toBeGreaterThanOrEqual(main.x + 16)
      expect(
        Math.abs(row.x + row.width / 2 - (main.x + main.width / 2)),
        `${at}: кнопки старта по центру страницы`,
      ).toBeLessThanOrEqual(2)
    } else {
      await expect(nav(page), `${at}: сайдбар спрятан, пока шторка закрыта`).toBeHidden()
      await expect(menuButton(page)).toBeVisible()
      expect(row.x, `${at}: кнопки старта с отступом слева`).toBeGreaterThanOrEqual(8)
      expect(row.x + row.width, `${at}: кнопки старта с отступом справа`).toBeLessThanOrEqual(width - 8)
      // Gutters are 16px, 24px from 700px, and the row stops at 448px.
      expect(row.width, `${at}: кнопки старта на всю ширину колонки`).toBeGreaterThanOrEqual(
        Math.min(448, width - 48) - 1,
      )

      // The drawer: the whole sidebar, over the page, with some of the page left to tap away.
      await menuButton(page).click()
      await expect(drawer(page)).toBeVisible()
      await expect(drawer(page).getByRole('navigation', { name: 'Основное' })).toBeVisible()
      await expect
        .poll(async () => Math.round((await drawer(page).boundingBox())?.x ?? -999), {
          message: `${at}: шторка выехала`,
        })
        .toBe(0)
      const sheet = (await drawer(page).boundingBox())!
      expect(sheet.width, `${at}: шторка уже окна`).toBeLessThan(width)
      expect(sheet.width, `${at}: шторка читаемой ширины`).toBeGreaterThanOrEqual(240)
      expect(sheet.height, `${at}: шторка на всю высоту`).toBeGreaterThanOrEqual(height - 2)
      await expect(brand).toBeVisible()
      await expect(newChat).toBeVisible()
      await expect(people).toBeVisible()
      await expect(noHistory).toBeVisible()
      await expect(accountMenu(page)).toContainText('Тест')
      if (walk) await shot(page, `web-shell-drawer-${width}`)

      // Esc puts it away, and the page behind it is where it was.
      await page.keyboard.press('Escape')
      await expect(drawer(page)).toHaveCount(0)
      await expect(nav(page)).toBeHidden()
      await expect(startVoiceButton(page)).toBeVisible()
    }
    await shot(page, `web-shell-${width}`)

    if (persistent && walk) {
      // The menu button folds the column to an icon rail and back.
      await menuButton(page).click()
      await expect
        .poll(async () => (await nav(page).boundingBox())?.width ?? 0, {
          message: `${at}: сайдбар свернулся`,
        })
        .toBeLessThan(80)
      await expect(newChat, `${at}: «Новый разговор» остался в рейке`).toBeVisible()
      await expect(accountMenu(page)).toBeVisible()
      await expect.poll(async () => (await page.getByRole('main').boundingBox())?.x ?? 999).toBeLessThan(80)
      await expectSingleSos(page)
      await expectNoHorizontalOverflow(page)
      await shot(page, `web-shell-collapsed-${width}`)
      await menuButton(page).click()
      await expect
        .poll(async () => (await nav(page).boundingBox())?.width ?? 0, {
          message: `${at}: сайдбар развернулся`,
        })
        .toBeGreaterThanOrEqual(240)
    }

    if (walk) {
      // Navigation is the sidebar: people nearby, then the profile from the account menu, then home.
      await goTo(page, 'Люди рядом')
      await expect(page).toHaveURL(/\/people$/)
      await expect(pageTitle(page)).toHaveText('Люди рядом')
      await expect(page).toHaveTitle('Люди рядом — Рядом')
      await expectSingleSos(page)
      await expectNoHorizontalOverflow(page)
      await openSidebar(page)
      await expect(people, `${at}: открытая страница отмечена в сайдбаре`).toHaveAttribute(
        'aria-current',
        'page',
      )
      await closeSidebar(page)

      await openProfile(page)
      await expect(page).toHaveTitle('Профиль — Рядом')
      await expectSingleSos(page)
      await expectNoHorizontalOverflow(page)

      await openSidebar(page)
      await brand.click()
      await expect(page).toHaveURL(/\/home$/)
      if (!persistent) await expect(drawer(page)).toHaveCount(0)
    }
  }
})

/**
 * The account menu at the foot of the sidebar: the profile and sign-out live there now that the
 * tabs are gone. Signing out leaves the account intact, and a signed-out visitor stays outside.
 */
test('меню аккаунта: профиль и выход', async ({ page }) => {
  test.setTimeout(120_000)
  const email = uniqueEmail('web-menu')
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, email)

  await openAccountMenu(page)
  await expect(menuItem(page, 'Профиль')).toBeVisible()
  await expect(menuItem(page, 'Выйти')).toBeVisible()
  // Esc closes the menu without choosing anything, and the account button keeps the focus.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(accountMenu(page)).toBeFocused()
  await expect(page).toHaveURL(/\/home$/)

  await openProfile(page)
  await expect(page.getByTestId('profile-email')).toHaveText(email)

  await openAccountMenu(page)
  await menuItem(page, 'Выйти').click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 20_000 })

  // Signed out means signed out: home without a session belongs to someone new, who meets the first
  // screen — the consent window asks at the first press (`openspec/changes/rework-web-first-screen`,
  // «Согласие при первом действии») ...
  await openWebApp(page, '/home')
  await expect(page.getByTestId('terms-gate')).toHaveCount(0)
  await expect(firstHello(page)).toBeVisible()
  await openSignIn(page)
  await expect(button(page, 'Войти')).toBeVisible()
  // ... and the account is still there for the next sign-in.
  await signIn(page, email)
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('home-greeting')).toContainText('Тест')
})

// The theme tests fix the local hour with the mocked clock: the palette is chosen by the boot script
// before the first paint, from the device time (07:00–21:59 light, 22:00–06:59 dark) or the manual
// choice stored under THEME_STORAGE_KEY of `@ryadom/client-core/theme`.
const THEME_STORAGE_KEY = 'ryadom.theme'

/** A fixed local moment for the schedule tests (the context's time zone is Europe/Moscow). */
function at(hour: number, minute: number, second = 0): Date {
  return new Date(2026, 10, 16, hour, minute, second)
}

/**
 * The palette the page wears: the `data-theme` attribute the tokens key on, the `dark` class, and the
 * two metas that must follow the theme — `color-scheme` and the browser chrome color, which the boot
 * script sets to the palette's own paper color, whatever literal the tokens use.
 */
async function expectTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const root = page.locator('html')
  if (theme === 'light') {
    await expect(root).toHaveAttribute('data-theme', 'light')
    await expect(root).not.toHaveClass(/(^|\s)dark(\s|$)/)
  } else {
    await expect(root).not.toHaveAttribute('data-theme', 'light')
    await expect(root).toHaveClass(/(^|\s)dark(\s|$)/)
  }
  expect(await currentTheme(page)).toBe(theme)
  await expect(page.locator('meta[name="color-scheme"]').first()).toHaveAttribute('content', theme)
  const paper = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ryadom-paper').trim(),
  )
  expect(paper, 'у палитры есть цвет фона').not.toBe('')
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', paper)
}

/**
 * Home for someone signed in: the sphere, the greeting as the page's one heading, «Начать разговор» and
 * the keyboard beside it, and the service's foot; no box, no suggestions, no «Настроить разговор», no
 * «Запоминать важное», no consent window. `openspec/changes/rework-web-first-screen`, «Главная
 * веб-клиента: старт голосом или текстом».
 */
test('главная вошедшего: один h1, «Начать разговор» и клавиатура; поля, подсказок и настроек нет', async ({
  page,
}) => {
  await openWebApp(page)
  await startAnonymously(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(page).toHaveTitle('Новый разговор — Рядом')

  // «Один заголовок первого уровня», «Нет имени»: a guest has no name, so the greeting is one word group.
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(pageTitle(page)).toHaveCount(1)
  await expect(pageTitle(page)).toHaveAttribute('data-testid', 'home-greeting')
  await expect(pageTitle(page)).toHaveText(/^(Поздний вечер|Доброе утро|Добрый день|Добрый вечер)$/)
  await expect(page.getByText('Я здесь и никуда не спешу. О чём хочется сказать?')).toBeVisible()
  await expect(page.getByTestId('home-orb')).toBeVisible()

  // «Два способа начать»: the wide voice button, and the keyboard as the quiet square beside it.
  await expect(startVoiceButton(page)).toHaveText('Начать разговор')
  await expect(startVoiceButton(page)).toBeEnabled()
  await expect(startTextButton(page)).toHaveAccessibleName('Начать текстом')
  await expect(startTextButton(page)).toBeEnabled()
  const voice = (await startVoiceButton(page).boundingBox())!
  const keyboard = (await startTextButton(page).boundingBox())!
  expect(voice.width, 'голос — главная кнопка').toBeGreaterThan(keyboard.width * 2)
  expect(Math.abs(voice.y - keyboard.y), 'клавиатура рядом с кнопкой').toBeLessThanOrEqual(2)

  // Nothing of the old home, and «Выбора режимов нет».
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.getByTestId('home-input')).toHaveCount(0)
  await expect(page.locator('[data-testid^="home-suggestion"]')).toHaveCount(0)
  await expect(page.getByTestId('home-talk')).toHaveCount(0)
  await expect(page.getByTestId('home-settings')).toHaveCount(0)
  await expect(page.getByText('Настроить разговор')).toHaveCount(0)
  await expect(page.getByText('Запоминать важное')).toHaveCount(0)
  await expect(page.getByTestId('memory-switch')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Выговориться|Поболтать|Вечерний ритуал/ })).toHaveCount(0)
  await expect(firstHello(page)).toHaveCount(0)
  await expect(modal(page)).toHaveCount(0)
  await expect(page.getByTestId('data-consent')).toHaveCount(0)
  await expect(page.getByTestId('guest-note')).toHaveCount(0)

  // «Строка о согласии у вошедшего», «Ссылка на «Люди рядом»»: the foot stays.
  const foot = page.getByTestId('home-foot')
  await expect(foot.getByTestId('consent-notice')).toContainText('ИИ для самоподдержки')
  await expect(foot).toContainText('В опасной ситуации звони 112.')
  await expect(foot.getByRole('link', { name: /Люди рядом.+линии помощи/ })).toHaveAttribute(
    'href',
    '/people',
  )
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await step(
    page,
    'home-signed-in',
    'Главная вошедшего: приветствие, «Начать разговор» и клавиатура; поля, подсказок и настроек нет',
  )
})

/**
 * The day/night palette by the local clock (`openspec/changes/add-fast-dialog-start`, «Русскоязычный
 * интерфейс и оформление»: «Дневное оформление», «Ночное оформление», «Границы темы»): light inside
 * [07:00, 22:00), dark otherwise, decided before the first paint, with `color-scheme` and the browser
 * chrome color to match. A newcomer's `/home` is the first screen
 * (`openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»).
 */
test('тема первого экрана следует местному времени: день, ночь и границы расписания', async ({ page }) => {
  await page.clock.install({ time: at(12, 0) })
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  await expectTheme(page, 'light')
  await step(page, 'theme-day', 'Днём (12:00) первый экран светлый: тёмный текст на светлом фоне')

  await page.clock.setSystemTime(at(23, 0))
  await page.reload({ waitUntil: 'networkidle' })
  await expect(firstHello(page)).toBeVisible()
  await expectTheme(page, 'dark')
  await step(page, 'theme-night', 'Ночью (23:00) первый экран тёмный')

  // The edges of the schedule itself: 06:59 is still night, 07:00 day; 21:59 still day, 22:00 night.
  for (const [hour, minute, theme] of [
    [6, 59, 'dark'],
    [7, 0, 'light'],
    [21, 59, 'light'],
    [22, 0, 'dark'],
  ] as const) {
    await page.clock.setSystemTime(at(hour, minute))
    await page.reload({ waitUntil: 'networkidle' })
    await expect(firstHello(page)).toBeVisible()
    await expectTheme(page, theme)
  }
})

/** Marks the current document: the mark is still there only if the page has not been reloaded since. */
async function markDocument(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => ((window as unknown as { __sameDocument?: boolean }).__sameDocument = true))
  return () =>
    page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true)
}

/**
 * «Смена темы без перезагрузки»: an open client arms a timer for the next 07:00/22:00 boundary and
 * repaints there by itself. The first screen has no box to keep a draft in, so the same document is what
 * shows that nothing was reloaded.
 *
 * The clock jumps (`fastForward`: each due timer fires once) rather than ticks through (`runFor`): the
 * first screen's sphere moves on every animation frame, and ticking through every frame of the gap keeps
 * the page busy far longer than the test may run.
 */
test('тема меняется на границе расписания без перезагрузки', async ({ page }) => {
  await page.clock.install({ time: at(21, 59, 30) })
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  await expectTheme(page, 'light')

  const sameDocument = await markDocument(page)
  await page.clock.fastForward(31_000)
  await expectTheme(page, 'dark')
  expect(await sameDocument(), 'страница не перезагружалась').toBe(true)
  await expect(firstHello(page)).toBeVisible()
  await step(
    page,
    'theme-boundary-flip',
    'На границе 22:00 тема первого экрана сменилась сама, без перезагрузки',
  )
})

/**
 * The manual switch («Ручное переключение», «Ручной выбор сохраняется», «Светлая тема системы»): tap and
 * keyboard flip the palette at once and without a request, the choice is stored on the device, wins over
 * the schedule and is not reset at a boundary; the control is a `switch` of at least 44×44 that stands
 * in the header right before SOS and does not cover it. The system palette is never read.
 */
test('переключатель темы: мышь и клавиатура, сохранение и приоритет над расписанием; SOS не перекрыт', async ({
  page,
}) => {
  const apiCalls = watchApiCalls(page)
  await page.clock.install({ time: at(23, 0) })
  // The OS palette must not matter: a light system theme leaves the schedule's dark one.
  await page.emulateMedia({ colorScheme: 'light' })
  await openWebApp(page)
  await expect(firstHello(page)).toBeVisible()
  await expectTheme(page, 'dark')

  const toggle = themeSwitch(page)
  await expect(toggle).toHaveAttribute('role', 'switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  // The name is the action the next press performs.
  await expect(toggle).toHaveAccessibleName('Включить светлую тему')
  const toggleBox = (await toggle.boundingBox())!
  expect(toggleBox.width, 'зона нажатия, ширина').toBeGreaterThanOrEqual(44)
  expect(toggleBox.height, 'зона нажатия, высота').toBeGreaterThanOrEqual(44)
  // Right before SOS, without covering it.
  const sosBox = (await sosButton(page).boundingBox())!
  expect(toggleBox.x + toggleBox.width, 'переключатель левее SOS').toBeLessThanOrEqual(sosBox.x + 1)
  await expectSingleSos(page)
  await step(page, 'theme-switch-night', 'Ночью переключатель показывает полумесяц, в шапке перед SOS')

  // A tap flips the palette at once, without a reload, and stores the choice on this device only.
  const sameDocument = await markDocument(page)
  await toggle.click()
  await expectTheme(page, 'light')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toHaveAccessibleName('Включить тёмную тему')
  expect(await sameDocument(), 'страница не перезагружалась').toBe(true)
  await expect(firstHello(page)).toBeVisible()
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBe('light')
  expect(apiCalls(), 'переключение темы не отправляет запросов').toEqual([])
  await step(page, 'theme-switch-day', 'После нажатия — светлая тема и солнце, первый экран на месте')

  // The keyboard flips it back.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expectTheme(page, 'dark')
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBe('dark')

  // The schedule boundary does not reset the manual choice: past 07:00 the schedule says light,
  // the stored dark stays. A jump, as above: nine hours of the sphere's frames would never finish.
  await page.clock.fastForward(9 * 3_600_000)
  await expectTheme(page, 'dark')

  // …and the choice survives a reload, still winning over the (now daytime) schedule.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(firstHello(page)).toBeVisible()
  await expectTheme(page, 'dark')
  await step(page, 'theme-manual-kept', 'Ручной выбор пережил границу 07:00 и перезагрузку: тема не сброшена')
  expect(apiCalls(), 'за весь сценарий ни одного запроса от имени человека').toEqual([])
})
