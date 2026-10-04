import { APP_URL } from '../playwright.config'
import {
  accountMenu,
  button,
  closeSidebar,
  drawer,
  expectNoHorizontalOverflow,
  expectSingleSos,
  field,
  goTo,
  homeInput,
  menuButton,
  menuItem,
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
  uniqueEmail,
  watchCsp,
  webUrl,
} from '../support/web'
import { clearMailbox } from '../support/mail'
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
  // The browser talks to the API directly: its address (REST and WebSocket) is the only extra origin.
  expect(policy['connect-src']).toEqual(
    expect.arrayContaining(["'self'", new URL(APP_URL).origin, APP_URL.replace(/^http/, 'ws')]),
  )

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
    ['/welcome', 'Добро пожаловать — Рядом'],
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
  for (const path of ['/welcome', '/login', '/register']) {
    await openWebApp(page, path)
    for (const width of [360, 820, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 })
      await expectNoHorizontalOverflow(page)
      // The form stays inside the window at every width, whichever way the card is laid out. The first
      // screen has no address field: its edge to hold is the group of agreements.
      const edge =
        path === '/welcome' ? page.getByTestId('consents') : field(page, 'email')
      const box = await edge.boundingBox()
      expect(box!.x, `${path}@${width}: форма слева`).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width, `${path}@${width}: форма справа`).toBeLessThanOrEqual(width)
      await expect(
        button(page, path === '/welcome' ? 'Начать' : path === '/login' ? 'Войти' : 'Создать аккаунт'),
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
    // On a phone this is also the drawer's first check: a link to the page that is already open
    // changes no path, and the drawer still has to go.
    await goTo(page, 'Новый разговор')
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByTestId('home-talk')).toBeVisible()
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
    const composer = (await page.locator('form', { has: homeInput(page) }).boundingBox())!

    if (persistent) {
      await expect(drawer(page)).toHaveCount(0)
      await expect(nav(page), `${at}: сайдбар на месте`).toBeVisible()
      await expect(menuButton(page)).toBeVisible()
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
      expect(composer.width, `${at}: колонка чата не шире 768px`).toBeLessThanOrEqual(770)
      expect(composer.x, `${at}: поле ввода не липнет к сайдбару`).toBeGreaterThanOrEqual(main.x + 16)
      expect(
        Math.abs(composer.x + composer.width / 2 - (main.x + main.width / 2)),
        `${at}: колонка по центру страницы`,
      ).toBeLessThanOrEqual(2)
    } else {
      await expect(nav(page), `${at}: сайдбар спрятан, пока шторка закрыта`).toBeHidden()
      await expect(menuButton(page)).toBeVisible()
      expect(composer.x, `${at}: поле ввода с отступом слева`).toBeGreaterThanOrEqual(8)
      expect(composer.x + composer.width, `${at}: поле ввода с отступом справа`).toBeLessThanOrEqual(width - 8)
      // Gutters are 16px, 24px from 700px.
      expect(composer.width, `${at}: поле ввода на всю ширину`).toBeGreaterThanOrEqual(width - 56)

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
      await expect(page.getByTestId('home-talk')).toBeVisible()
    }
    await shot(page, `web-shell-${width}`)

    if (persistent && walk) {
      // The menu button folds the column to an icon rail and back.
      await menuButton(page).click()
      await expect
        .poll(async () => (await nav(page).boundingBox())?.width ?? 0, { message: `${at}: сайдбар свернулся` })
        .toBeLessThan(80)
      await expect(newChat, `${at}: «Новый разговор» остался в рейке`).toBeVisible()
      await expect(accountMenu(page)).toBeVisible()
      await expect.poll(async () => (await page.getByRole('main').boundingBox())?.x ?? 999).toBeLessThan(80)
      await expectSingleSos(page)
      await expectNoHorizontalOverflow(page)
      await shot(page, `web-shell-collapsed-${width}`)
      await menuButton(page).click()
      await expect
        .poll(async () => (await nav(page).boundingBox())?.width ?? 0, { message: `${at}: сайдбар развернулся` })
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
      await expect(people, `${at}: открытая страница отмечена в сайдбаре`).toHaveAttribute('aria-current', 'page')
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

  // Signed out means signed out: the app does not open without a session ...
  await openWebApp(page, '/home')
  await expect(page).toHaveURL(/\/login$/)
  await expect(button(page, 'Войти')).toBeVisible()
  // ... and the account is still there for the next sign-in.
  await signIn(page, email)
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('home-greeting')).toContainText('Тест')
})
