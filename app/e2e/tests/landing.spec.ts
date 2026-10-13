import { PWA_URL, WEBAPP_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'

/** The landing site: it has to work without the database, without the core and without the app. */

test('главная рассказывает, что это, и ведёт в приложение', async ({ page, shot }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1 })).toContainText('рядом')
  // The promise is to help sort out one's thoughts, not only to listen.
  await expect(page.getByText('поможет разобраться в мыслях').first()).toBeVisible()
  // Being honest about what this is not is part of the product, not decoration.
  await expect(page.getByRole('heading', { name: 'Психотерапия и не замена людям' })).toBeVisible()
  // The app starts without signing up, so the site must not promise a registration by email.
  await expect(page.getByText('Можно без регистрации.')).toBeVisible()
  await expect(page.getByText(/Регистрация (по почте|занимает)/)).toHaveCount(0)
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
