import { PWA_URL, WEBAPP_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'
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
  await expect(page.getByRole('heading', { name: 'Политика конфиденциальности' })).toBeVisible()
  // This is the exact statement the app stores check.
  await expect(page.getByText('Аудиозаписи не создаются и не хранятся')).toBeVisible()

  await page.goto('/terms')
  await expect(page.getByRole('heading', { name: 'Пользовательское соглашение' })).toBeVisible()

  await page.goto('/delete-account')
  await expect(page.getByRole('heading', { name: 'Удаление аккаунта и данных' })).toBeVisible()
  await shot(page, 'delete-account', { fullPage: true })

  await page.goto('/download')
  await expect(page.getByRole('heading', { name: 'Скачать «Рядом»' })).toBeVisible()
  await shot(page, 'download', { fullPage: true })
})

test('несуществующая страница отвечает 404, а не падает', async ({ page }) => {
  const response = await page.goto('/no-such-page')
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Такой страницы нет' })).toBeVisible()
})

test('robots.txt закрывает страницы ссылок на разговоры и оставляет остальной сайт открытым', async ({ page }) => {
  const response = await page.request.get('/robots.txt')
  expect(response.ok()).toBe(true)
  const body = await response.text()
  expect(body).toMatch(/^Disallow: \/app\/s\/$/m)
  expect(body).toMatch(/^Allow: \/$/m)
})

test('Метрика на лендинге: запись экрана и карта кликов — только здесь, адрес без лишнего', async ({ page }) => {
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
  for (const target of [emergency, emergency.locator('xpath=ancestor::*[contains(@class, "ph-no-capture")][1]')]) {
    await expect(target).toHaveClass(/ym-disable-clickmap/)
    await expect(target).toHaveClass(/ym-hide-content/)
    await expect(target).toHaveClass(/ph-no-capture/)
  }
})

test('политика конфиденциальности называет Яндекс Метрику, её cookie и прямую передачу адреса', async ({ page }) => {
  await page.goto('/privacy')
  const paragraph = page.locator('p', { hasText: 'Яндекс Метрика.' })
  await expect(paragraph).toBeVisible()
  await expect(paragraph).toContainText('ООО «ЯНДЕКС»')
  await expect(paragraph).toContainText('файл cookie')
  await expect(paragraph).toContainText('IP-адрес')
  await expect(paragraph).toContainText('Отказ от сбора')
})
