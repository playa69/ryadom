import type { Page } from '@playwright/test'
import { PWA_URL, WEBAPP_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'
import { step } from '../support/evidence'
import { E2E_COUNTER_ID, hitUrls, refusedMetrikaRequests, ymCalls } from '../support/metrika'

/** The landing site: it has to work without the database, without the core and without the app. */

test('главная рассказывает, что это, и ведёт в приложение', async ({ page, shot }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1 })).toContainText('рядом')
  // Being honest about what this is not is part of the product, not decoration.
  await expect(page.getByRole('heading', { name: 'Психотерапия и не замена людям' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Открыть приложение' }).first()).toHaveAttribute(
    'href',
    WEBAPP_URL,
  )

  await shot(page, 'landing', { fullPage: true })
})

test('страница «Скачать» ведёт на PWA и объясняет, как её установить', async ({ page }) => {
  await page.goto('/download')

  const install = page.getByRole('link', { name: 'Открыть и установить' })
  // The link ends with a slash: that is the PWA's scope, and without it the host would redirect.
  await expect(install).toHaveAttribute('href', `${PWA_URL}/`)
  await expect(page.getByRole('heading', { name: 'Установить из браузера' })).toBeVisible()
  // One instruction per kind of device, so a person finds their own.
  await expect(page.getByText('Android, Chrome')).toBeVisible()
  await expect(page.getByText('iPhone и iPad, Safari')).toBeVisible()
  await expect(page.getByText('Компьютер, Chrome или Edge')).toBeVisible()
})

test('телефоны помощи видны и набираются в один тап', async ({ page }) => {
  await page.goto('/')
  const emergency = page.getByRole('link', { name: '112', exact: true })
  await expect(emergency).toBeVisible()
  await expect(emergency).toHaveAttribute('href', 'tel:112')
})

test('правовые страницы и страница удаления открываются', async ({ page, shot }) => {
  await page.goto('/privacy')
  // `openspec/changes/update-privacy-policy`, «Политика конфиденциальности и пользовательское соглашение».
  await expect(
    page.getByRole('heading', {
      name: 'Политика обработки персональных данных сервиса «Рядом»',
      exact: true,
    }),
  ).toBeVisible()
  for (const heading of [
    '1. Общие положения',
    '2. Цели, данные, основания и сроки',
    '3. Хранение и передача данных',
    '4. Порядок обработки и защита данных',
    '5. Ваши права и удаление данных',
    '6. Cookie, возраст, изменения и контакты',
  ]) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await expect(page.getByText('100488024', { exact: false })).toBeVisible()
  await expect(page.getByText('Запись голоса не сохраняется нигде.').first()).toBeVisible()
  await step(page, 'privacy-document', 'Политика: предоставленный заголовок и шесть разделов', {
    fullPage: true,
    keepDates: true,
  })

  const conversationRow = page.locator('tbody tr', { hasText: 'Текст разговора: расшифровка ваших слов' })
  await expect(conversationRow).toContainText('1, 2')
  await expect(conversationRow.getByText('30 дней', { exact: true })).toBeVisible()
  await expect(page.getByText(/аккаунт без активности удаляется через 90 дней/)).toBeVisible()
  await conversationRow.scrollIntoViewIfNeeded()
  await step(page, 'privacy-retention', 'Разговор хранится 30 дней, неактивный аккаунт — 90 дней')

  const selfCheck = page.locator('p', { hasText: '2.5. Опросники самопроверки' })
  await expect(selfCheck).toContainText('ответы и результаты хранятся только на вашем устройстве')
  await expect(selfCheck).toContainText('Оператору не передаются')
  await selfCheck.scrollIntoViewIfNeeded()
  await step(page, 'privacy-self-check', 'Самопроверка: ответы и результаты только на устройстве')

  for (const text of ['ООО «ТАЙМВЭБ.КЛАУД»', 'Облачные технологии', 'ООО «ЯНДЕКС»']) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible()
  }
  await expect(page.getByText('PostHog Cloud EU', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Трансграничная передача персональных данных не осуществляется.')).toBeVisible()
  await expect(page.locator('li', { hasText: 'отдельным ключом для каждого аккаунта' })).toBeVisible()
  await expect(page.locator('li', { hasText: 'с двухфакторной аутентификацией' })).toBeVisible()
  await expect(page.locator('li', { hasText: 'перед отправкой текста ИИ-модели' })).toBeVisible()
  await expect(
    page.getByText('резервные копии зашифрованы и хранятся 30 дней', { exact: false }),
  ).toBeVisible()
  await expect(page.getByText('журналы хранятся 7 дней', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: '«Стереть всё»', exact: true })).toHaveAttribute(
    'href',
    '/delete-account',
  )
  await page.locator('li', { hasText: 'отдельным ключом для каждого аккаунта' }).scrollIntoViewIfNeeded()
  await step(page, 'privacy-protection', 'Обработчики, шифрование, маскирование, копии и журналы')

  // `openspec/changes/add-explicit-data-consent`, «Публичный текст согласия на обработку персональных данных».
  await page.goto('/consent')
  await expect(
    page.getByRole('heading', { name: 'Согласие на обработку персональных данных', exact: true }),
  ).toBeVisible()
  await expect(page.locator('ol').getByRole('listitem')).toHaveCount(6)
  await expect(page.getByText('Редакция согласия: 1.0 от 05/11/2026', { exact: false })).toBeVisible()
  await expect(page.getByText('100488024', { exact: false })).toBeVisible()
  await shot(page, 'consent', { fullPage: true })
  await step(page, 'consent-document', 'Публичный текст согласия: шесть пунктов, редакция и номер реестра')
  await page.getByRole('link', { name: 'Политикой обработки персональных данных', exact: true }).click()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(
    page.getByRole('heading', {
      name: 'Политика обработки персональных данных сервиса «Рядом»',
      exact: true,
    }),
  ).toBeVisible()
  await step(page, 'consent-privacy', 'Из согласия открывается отдельная политика конфиденциальности')

  await page.goto('/terms')
  await expect(
    page.getByRole('heading', { name: 'Пользовательское соглашение сервиса «Рядом»', exact: true }),
  ).toBeVisible()

  await page.goto('/delete-account')
  await expect(page.getByRole('heading', { name: 'Удаление аккаунта и данных' })).toBeVisible()
  await shot(page, 'delete-account', { fullPage: true })

  await page.goto('/download')
  await expect(page.getByRole('heading', { name: 'Скачать «Рядом»' })).toBeVisible()
  await shot(page, 'download', { fullPage: true })
})

// openspec/changes/update-terms, «Политика конфиденциальности и пользовательское соглашение».
test('соглашение: редакция, выделенные границы и все 14 разделов', async ({ page }) => {
  await page.goto('/terms')
  const document = page.locator('main')

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Пользовательское соглашение сервиса «Рядом»',
  )
  await expect(document).toContainText('Редакция от 05.11.2026.')
  await expect(document).toContainText('Публикуется по адресу слышу-рядом.рф/terms.')
  await expect(document).toContainText('Собеседник — искусственный интеллект.')
  await expect(document).toContainText('Если есть угроза жизни — звоните 112.')
  await step(page, 'terms-intro', 'Новая редакция и выделенные границы сервиса', { keepDates: true })

  const rules = document.getByRole('heading', { name: '7. Как нельзя пользоваться сервисом' })
  await rules.scrollIntoViewIfNeeded()
  await expect(rules).toBeVisible()
  await step(page, 'terms-rules', 'Правила использования читаются в общей типографике документа')

  await expect(document.getByRole('heading', { level: 2 })).toHaveText([
    '1. Стороны и принятие условий',
    '2. Что такое сервис',
    '3. Возраст',
    '4. Безопасность и границы сервиса',
    '5. Аккаунт без регистрации',
    '6. Уведомления',
    '7. Как нельзя пользоваться сервисом',
    '8. Стоимость',
    '9. Интеллектуальная собственность',
    '10. Ответственность',
    '11. Изменения и прекращение',
    '12. Приложения из магазинов и Telegram',
    '13. Применимое право и споры',
    '14. Связь',
  ])
  await step(page, 'terms-sections', 'В документе присутствуют все 14 разделов', { fullPage: true })
})

test('соглашение: оферта, отдельное согласие и аккаунт без регистрации', async ({ page }) => {
  await page.goto('/terms')
  const document = page.locator('main')

  await expect(document).toContainText('Соглашение — публичная оферта (ст. 437 ГК РФ).')
  await expect(document).toContainText('отдельным согласием на обработку персональных данных')
  await expect(
    document.getByRole('link', { name: 'Политикой обработки персональных данных', exact: true }),
  ).toHaveAttribute('href', '/privacy')
  await step(page, 'terms-offer', 'Оферта и отдельное согласие на обработку данных')

  await expect(document).toContainText('Регистрация не нужна.')
  await document.getByRole('heading', { name: '5. Аккаунт без регистрации' }).scrollIntoViewIfNeeded()
  await step(page, 'terms-anonymous', 'Аккаунт создаётся на устройстве без обязательной регистрации')

  await expect(document).toContainText('одноразовым кодом или QR-кодом из настроек')
  await expect(document).toContainText('Аккаунт без активности удаляется автоматически через 90 дней.')
  await expect(document.getByRole('link', { name: '«Стереть всё»', exact: true })).toHaveCount(2)
  const erase = document.getByRole('link', { name: '«Стереть всё»', exact: true }).first()
  await expect(erase).toHaveAttribute('href', '/delete-account')
  await erase.scrollIntoViewIfNeeded()
  await step(page, 'terms-account', 'Перенос, 90 дней без активности и необратимое удаление')
})

test('соглашение: технологии, возраст и кризисные границы', async ({ page }) => {
  await page.goto('/terms')
  const document = page.locator('main')

  await expect(document).toContainText('Речь распознаётся и озвучивается сервисом SaluteSpeech')
  await expect(document).toContainText('ответы формирует модель GigaChat')
  await expect(document).toContainText('Ответы ИИ могут быть неточными')
  await document.getByRole('heading', { name: '2. Что такое сервис' }).scrollIntoViewIfNeeded()
  await step(page, 'terms-ai', 'Технологии и ограничения ответов искусственного интеллекта')

  await expect(document).toContainText('Сервисом могут пользоваться лица, достигшие 18 лет.')
  await document.getByRole('heading', { name: '3. Возраст' }).scrollIntoViewIfNeeded()
  await step(page, 'terms-age', 'Сервис предназначен для людей старше 18 лет')

  await expect(document).toContainText('не ждите реакции сервиса и звоните 112')
  await expect(document).toContainText('Мы не вызываем за вас службы, не связываемся с вашими близкими')
  await document.getByRole('heading', { name: '4. Безопасность и границы сервиса' }).scrollIntoViewIfNeeded()
  await step(page, 'terms-safety', 'Кризисные границы: звонок 112 остаётся за человеком')
})

test('соглашение: площадки, споры и связь с правообладателем', async ({ page }) => {
  await page.goto('/terms')
  const document = page.locator('main')

  await expect(document).toContainText('Соглашение заключено между вами и нами, а не с Apple Inc.')
  await expect(document).toContainText('через Google Play, RuStore или Telegram')
  await document
    .getByRole('heading', { name: '12. Приложения из магазинов и Telegram' })
    .scrollIntoViewIfNeeded()
  await step(page, 'terms-stores', 'Дополнительные условия App Store и других площадок')

  await expect(document).toContainText('К Соглашению применяется право Российской Федерации.')
  await expect(document).toContainText('Как потребитель вы можете подать иск и по месту своего жительства.')
  await document.getByRole('heading', { name: '13. Применимое право и споры' }).scrollIntoViewIfNeeded()
  await step(page, 'terms-law', 'Применимое право и порядок рассмотрения споров')

  await expect(document).toContainText('Правообладатель: физическое лицо Валясин Александр Микаэлович.')
  const email = document.getByRole('link', { name: 'playasn@yandex.ru', exact: true })
  await expect(email).toHaveCount(2)
  for (const link of await email.all()) {
    await expect(link).toHaveAttribute('href', 'mailto:playasn@yandex.ru')
  }
  await document.getByRole('heading', { name: '14. Связь' }).scrollIntoViewIfNeeded()
  await step(page, 'terms-contact', 'Почта и имя правообладателя в разделе связи')
})

test('несуществующая страница отвечает 404, а не падает', async ({ page }) => {
  const response = await page.goto('/no-such-page')
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Такой страницы нет' })).toBeVisible()
})

test('robots.txt закрывает страницы ссылок на разговоры и оставляет остальной сайт открытым', async ({
  page,
}) => {
  const response = await page.request.get('/robots.txt')
  expect(response.ok()).toBe(true)
  const body = await response.text()
  expect(body).toMatch(/^Disallow: \/app\/s\/$/m)
  expect(body).toMatch(/^Allow: \/$/m)
})

test('Метрика на лендинге: запись экрана и карта кликов — только здесь, адрес без лишнего', async ({
  page,
}) => {
  // The query carries a campaign label and something that must not leave; the fragment must not either.
  await page.goto('/?utm_source=e2e&secret=SECRET-E2E-QUERY#SECRET-E2E-FRAGMENT')
  await expect.poll(() => hitUrls(page)).not.toHaveLength(0)

  const [init] = await ymCalls(page, 'init')
  expect(init![0]).toBe(E2E_COUNTER_ID)
  // The environment of the stack allows both, and the landing is the one place that acts on it.
  expect(init![2]).toMatchObject({ defer: true, webvisor: true, clickmap: true, trackLinks: false })

  const hits = await ymCalls(page, 'hit')
  expect(String(hits[0]![2])).toMatch(/^http:\/\/[^/]+\/\?utm_source=e2e$/)
  expect(hits[0]![3]).toMatchObject({ params: { app_platform: 'landing' } })
  const everything = JSON.stringify(await ymCalls(page))
  expect(everything).not.toContain('SECRET-E2E-QUERY')
  expect(everything).not.toContain('SECRET-E2E-FRAGMENT')
  expect(refusedMetrikaRequests(page)).toEqual([])
})

test('Метрика на лендинге: телефоны помощи закрыты от карты кликов и записи сеанса', async ({ page }) => {
  await page.goto('/')
  const emergency = page.getByRole('link', { name: '112', exact: true })
  await expect(emergency).toBeVisible()
  // The link and its row carry the classes the Metrika tag itself looks for (and PostHog's).
  for (const target of [
    emergency,
    emergency.locator('xpath=ancestor::*[contains(@class, "ph-no-capture")][1]'),
  ]) {
    await expect(target).toHaveClass(/ym-disable-clickmap/)
    await expect(target).toHaveClass(/ym-hide-content/)
    await expect(target).toHaveClass(/ph-no-capture/)
  }
})

test('политика: адаптивные таблицы и отказ от аналитики', async ({ page }) => {
  await page.goto('/privacy')
  const firstCell = page.locator('tbody tr').first().locator('td').first()
  await expect(firstCell).toHaveAttribute('data-label', 'Данные')
  if ((page.viewportSize()?.width ?? 1280) <= 720) {
    await expect(firstCell).toHaveCSS('display', 'block')
    expect(await firstCell.evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('"Данные"')
  }
  await step(page, 'privacy-tables', 'Таблица данных читается без горизонтальной прокрутки', {
    fullPage: true,
  })

  const optIn = page.getByTestId('analytics-opt-in').getByRole('checkbox')
  await optIn.scrollIntoViewIfNeeded()
  await expect(optIn).toBeChecked()
  await optIn.uncheck()
  await expect(optIn).not.toBeChecked()
  await page.reload()
  await expect(optIn).not.toBeChecked()
  await step(page, 'privacy-opt-out', 'Отказ от аналитики сохраняется после перезагрузки')
  await optIn.check()
  await expect(optIn).toBeChecked()
})

test('политика описывает согласие на Метрику, а связь ведёт на почту Оператора', async ({ page }) => {
  await page.goto('/privacy')
  const paragraph = page.locator('p', { hasText: '6.1. Cookie и Яндекс Метрика.' })
  await expect(paragraph).toBeVisible()
  await expect(paragraph).toContainText('только после вашего согласия в баннере')
  await expect(paragraph).toContainText('До согласия Метрика не загружается')
  await expect(paragraph).toContainText('Запись действий на экране (Вебвизор) и содержимого полей выключена')
  await expect(paragraph).toContainText('В приложениях Яндекс Метрика не используется')
  await expect(page.getByTestId('analytics-opt-in')).toBeVisible()

  // `openspec/changes/update-privacy-policy`, «Публичные адреса из окружения».
  const footerEmail = page.locator('footer').getByRole('link', { name: 'playasn@yandex.ru', exact: true })
  await expect(footerEmail).toHaveAttribute('href', 'mailto:playasn@yandex.ru')
  await expect(page.getByRole('link', { name: 'support@ryadom.local', exact: true })).toHaveCount(0)
  await footerEmail.scrollIntoViewIfNeeded()
  await step(page, 'operator-email', 'Блок «Связь» ведёт на playasn@yandex.ru')

  await page.goto('/terms')
  const termsEmail = page.getByRole('link', { name: 'playasn@yandex.ru', exact: true }).first()
  await expect(termsEmail).toBeVisible()
  await expect(termsEmail).toHaveAttribute('href', 'mailto:playasn@yandex.ru')
})

/*
 * `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: тема лендинга
 * по местному времени устройства (светлая в [07:00, 22:00), тёмная иначе), ручной выбор через
 * общий модуль темы и его приоритет над расписанием. Системная палитра не читается никогда.
 */

/** The shared key of the manual choice (packages/client-core/src/theme.ts), one for the site and the clients. */
const THEME_STORAGE_KEY = 'ryadom.theme'
// Fixed local times (the stand and the browser share Europe/Moscow): noon is light, 23:00 is dark.
const DAY = '2026-11-16T12:00:00+03:00'
const NIGHT = '2026-11-16T23:00:00+03:00'
const BEFORE_DARK_BOUNDARY = '2026-11-16T21:59:50+03:00'
const AFTER_DARK_BOUNDARY_NEXT_DAY = '2026-11-17T08:00:00+03:00'
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
  }, THEME_STORAGE_KEY)
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

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: сценарии
// «Дневное оформление», «Ночное оформление» и «Тема публичных страниц лендинга».
test('тема: днём главная и документы светлые, ночью тёмные', async ({ page }) => {
  await page.clock.install({ time: new Date(DAY) })
  await page.goto('/')

  expectLightTheme(await themeState(page))
  // Exactly one compact switch, readable as a switch and named after the action the next press does.
  const switcher = page.getByTestId('theme-switch')
  await expect(switcher).toHaveCount(1)
  await expect(switcher).toHaveAttribute('role', 'switch')
  await expect(switcher).toHaveAttribute('aria-checked', 'false')
  await expect(switcher).toHaveAccessibleName('Включить тёмную тему')
  await step(page, 'landing-light', 'Днём главная светлая: тёмный текст, светлый фон и цвет окна браузера')

  await page.goto('/privacy')
  expectLightTheme(await themeState(page))
  await expect(page.getByTestId('theme-switch')).toBeVisible()
  await step(page, 'landing-docs-light', 'Страница документов днём тоже светлая, переключатель справа сверху')

  await page.clock.setFixedTime(new Date(NIGHT))
  await page.reload()
  expectDarkTheme(await themeState(page))
  await expect(switcher).toHaveAttribute('aria-checked', 'true')
  await expect(switcher).toHaveAccessibleName('Включить светлую тему')
  await step(
    page,
    'landing-docs-dark',
    'Ночью документы тёмные: переключатель показывает светящийся полумесяц',
  )

  await page.goto('/')
  expectDarkTheme(await themeState(page))
  await step(page, 'landing-dark', 'Ночью главная тёмная, цветовая схема и цвет окна браузера тёмные')
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: сценарий
// «Тема публичных страниц лендинга» — тема выставляется до первой отрисовки без мигания.
test('тема: палитра выставлена до первой отрисовки, без клиентских скриптов', async ({ page }) => {
  // The server markup is always dark (the CSS default): only the inline boot script can paint the
  // light palette. With the bundle blocked the right marks prove the first paint sees the theme.
  const html = await (await page.request.get('/')).text()
  expect(html).toContain('class="dark"')

  await page.route('**/_next/static/**/*.js', (route) => route.abort())
  await page.clock.install({ time: new Date(DAY) })
  await page.goto('/')

  expectLightTheme(await themeState(page))
  await step(page, 'landing-boot-light', 'Светлая тема стоит до клиентских скриптов: отрисовка без мигания')
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: сценарий
// «Светлая тема системы» — системная палитра не влияет на выбор.
test('тема: системная палитра устройства не влияет на выбор', async ({ page }) => {
  await page.clock.install({ time: new Date(NIGHT) })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  expectDarkTheme(await themeState(page))

  await page.clock.setFixedTime(new Date(DAY))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  expectLightTheme(await themeState(page))
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: сценарий
// «Ручное переключение» — нажатие, клавиатура и свайп, зона 44×44, без запроса и потери состояния.
test('тема: переключатель — нажатие, клавиатура и свайп, без запроса', async ({ page }) => {
  await page.clock.install({ time: new Date(DAY) })
  await page.goto('/')

  const switcher = page.getByTestId('theme-switch')
  await expect(switcher).toBeVisible()
  const zone = await switcher.boundingBox()
  expect(zone).not.toBeNull()
  expect(zone!.width).toBeGreaterThanOrEqual(44)
  expect(zone!.height).toBeGreaterThanOrEqual(44)

  // A theme flip is a purely local affair: nothing may leave the device for it.
  await page.waitForLoadState('networkidle')
  const apiCalls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiCalls.push(request.url())
  })

  await switcher.click()
  const tapped = await themeState(page)
  expectDarkTheme(tapped)
  expect(tapped.manualChoice).toBe('dark')
  await expect(switcher).toHaveAttribute('aria-checked', 'true')
  await expect(switcher).toHaveAccessibleName('Включить светлую тему')
  await step(page, 'landing-theme-tap', 'Нажатие переключателя сразу включило тёмную тему')

  await switcher.focus()
  await page.keyboard.press('Enter')
  expectLightTheme(await themeState(page))
  await expect(switcher).toHaveAttribute('aria-checked', 'false')

  // A horizontal drag across the pill is a swipe asking for the side it points to.
  const pill = await switcher.boundingBox()
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2)
  await page.mouse.down()
  await page.mouse.move(pill!.x + pill!.width / 2 + 40, pill!.y + pill!.height / 2, { steps: 5 })
  await page.mouse.up()
  expectDarkTheme(await themeState(page))
  await step(page, 'landing-theme-swipe', 'Свайп по переключателю снова включил тёмную тему')

  expect(apiCalls).toEqual([])
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: сценарий
// «Ручной выбор сохраняется» — перезагрузка и граница расписания ручной выбор не сбрасывают.
test('тема: ручной выбор переживает перезагрузку и важнее расписания', async ({ page }) => {
  await page.clock.install({ time: new Date(NIGHT) })
  await page.goto('/')
  expectDarkTheme(await themeState(page))

  await page.getByTestId('theme-switch').click()
  expectLightTheme(await themeState(page))

  await page.reload()
  const reloaded = await themeState(page)
  expectLightTheme(reloaded)
  expect(reloaded.manualChoice).toBe('light')
  await step(
    page,
    'landing-theme-persist',
    'Ночью после перезагрузки остаётся выбранная вручную светлая тема',
  )

  // The 07:00 boundary fires in the open page, but the stored choice still wins over the schedule.
  await page.clock.setFixedTime(new Date(BEFORE_LIGHT_BOUNDARY_NEXT_DAY))
  await page.clock.runFor(10_000)
  const afterBoundary = await themeState(page)
  expectLightTheme(afterBoundary)
  expect(afterBoundary.manualChoice).toBe('light')
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: сценарий
// «Смена темы без перезагрузки» — граница расписания и возврат на вкладку.
test('тема: открытая страница меняет тему на границе и при возврате на вкладку', async ({ page }) => {
  await page.clock.install({ time: new Date(BEFORE_DARK_BOUNDARY) })
  await page.goto('/')
  expectLightTheme(await themeState(page))

  // Ten seconds later the schedule flips at 22:00 and the open page follows without a reload.
  await page.clock.runFor(20_000)
  await expect.poll(async () => (await themeState(page)).colorScheme).toBe('dark')
  expectDarkTheme(await themeState(page))
  await step(
    page,
    'landing-theme-boundary',
    'После 22:00 открытая страница сама стала тёмной, без перезагрузки',
  )

  // A tab that slept through a boundary re-checks the schedule when it becomes visible again.
  await page.clock.setFixedTime(new Date(AFTER_DARK_BOUNDARY_NEXT_DAY))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(async () => (await themeState(page)).colorScheme).toBe('light')
  expectLightTheme(await themeState(page))
})

// `openspec/changes/add-fast-dialog-start`, «Русскоязычный интерфейс и оформление»: на узком экране
// переключатель темы не перекрывает и не обрезает остальные действия шапки.
test('тема: шапка не перекрывает действия на узком экране', async ({ page }) => {
  await page.goto('/')

  const header = page.locator('header')
  const actions = [
    page.getByTestId('theme-switch'),
    header.getByRole('link', { name: 'Скачать', exact: true }),
    header.getByRole('link', { name: 'Открыть', exact: true }),
  ]
  const viewportWidth = page.viewportSize()?.width ?? 1280
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  for (const action of actions) {
    await expect(action).toBeVisible()
    const box = await action.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth + 1)
    boxes.push(box!)
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i]!, boxes[j]!]
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlap).toBe(false)
    }
  }
  await step(
    page,
    'landing-header-fit',
    'Шапка: переключатель темы, «Скачать» и «Открыть» видны целиком и не перекрываются',
  )
})
