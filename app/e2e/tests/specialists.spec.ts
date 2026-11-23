import { PWA_URL, WEBAPP_URL } from '../playwright.config'
import { openApp, startAnonymously } from '../support/app'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'

const CREDIT = 'Создано при участии гештальт-терапевтов'
const TITLE = 'Специалисты, которые помогали создавать «Рядом»'

// PROTEUS-333, credit-therapists-and-improve-pwa: «Участие специалистов на лендинге».
test('лендинг показывает участие специалистов и число разговоров', async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByText('Создано при участии практикующих гештальт-терапевтов')).toBeVisible()
  await expect(page.getByText(/Выслушано более 14\s000 разговоров/)).toBeVisible()
  await step(page, 'landing-credit', 'Баннер и число разговоров на первом экране')

  const contributors = page.locator('section#modes + section#contributors:has(+ section#safety)')
  await expect(contributors.getByRole('heading', { name: 'Кто помогал создавать' })).toBeVisible()
  await expect(contributors.getByRole('heading', { level: 3 })).toHaveCount(4)
  await expect(contributors.getByRole('heading', { level: 3 }).first()).toHaveText('Алексей Лаптев')
  await contributors.scrollIntoViewIfNeeded()
  await step(page, 'landing-contributors', 'Карточки между режимами разговора и безопасностью')
})

// PROTEUS-333, REQ-SAFE-04, REQ-CARE-03, REQ-ACC-01: SOS ведёт к отдельному блоку специалистов.
test('веб: вход и переход из SOS к записи на консультацию', async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${WEBAPP_URL}/login`)
  await expect(page.getByText(CREDIT)).toBeVisible()
  await step(page, 'web-login-credit', 'Строка доверия при входе в веб-приложение')
  await page.goto(`${WEBAPP_URL}/home`)
  await page.getByRole('button', { name: 'SOS', exact: true }).click()

  const sos = page.getByRole('dialog', { name: 'Если сейчас тяжело' })
  await expect(sos.locator('a[href^="tel:"]')).toHaveCount(3)
  await expect(sos.locator('a[href="tel:112"]')).toBeVisible()
  await expect(sos.getByRole('button', { name: 'Специалисты' })).toHaveCSS(
    'background-image',
    /radial-gradient.*linear-gradient/,
  )
  await step(page, 'web-sos-specialists', 'Круглосуточные линии и зелёная кнопка «Специалисты» в SOS')
  await sos.getByRole('button', { name: 'Специалисты' }).click()
  await expect(sos).toBeHidden()
  await expect(page).toHaveURL(/\/people#specialists$/)
  await expect(page.getByRole('heading', { name: TITLE })).toBeInViewport()
  const specialists = page.locator('#specialists')
  await expect(specialists.locator('a[href^="tel:"]')).toHaveCount(4)
  await expect(specialists.getByRole('heading', { level: 3 }).first()).toHaveText('Алексей Лаптев')
  await step(page, 'web-people-specialists', 'Плановые консультации в разделе «Люди рядом»')
})

// PROTEUS-333, REQ-SAFE-04, REQ-CARE-03, REQ-ACC-01: тот же путь в PWA, в том числе без аккаунта.
test('PWA: вход и переход из SOS к специалистам без аккаунта', async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  await page.getByTestId('have-account').click()
  await expect(page.locator('.page-current').getByText(CREDIT)).toBeVisible()
  await step(page, 'pwa-login-credit', 'Строка доверия при входе в PWA')
  await page.goto(`${PWA_URL}/`)
  await page.locator('.page-current').getByTestId('have-account').waitFor()
  await page.locator('.page-current .rd-sos-button').click()
  const sos = page.locator('.sheet-modal.modal-in').filter({ hasText: 'Если сейчас тяжело' })
  await expect(sos.locator('a[href^="tel:"]')).toHaveCount(3)
  await expect(sos.locator('a[href="tel:112"]')).toBeVisible()
  await expect(sos.getByRole('button', { name: 'Специалисты' })).toHaveCSS(
    'background-image',
    /radial-gradient.*linear-gradient/,
  )
  await step(page, 'pwa-sos-specialists', 'Круглосуточные линии и зелёная кнопка «Специалисты» SOS в PWA')
  await sos.getByRole('button', { name: 'Специалисты' }).click()
  await expect(sos).toBeHidden()
  const people = page.locator('.page-current[data-name="people"]')
  const heading = people.getByRole('heading', { name: TITLE })
  await expect(heading).toBeFocused()
  await expect(heading).toBeInViewport({ ratio: 1 })
  await expect(people.locator('article a[href^="tel:"]')).toHaveCount(4)
  await expect(people.getByRole('heading', { level: 3 }).first()).toHaveText('Алексей Лаптев')
  await step(page, 'pwa-people-specialists', 'Плановые консультации в PWA доступны без входа')
})

// PROTEUS-333, «Размещение элементов мобильной главной».
test('PWA: шар отцентрирован ниже SOS и темы, в том числе в офлайне', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await openApp(page)
  await startAnonymously(page)
  const home = page.locator('.page-current[data-name="home"]')
  const orb = home.locator('.rd-home-orb')
  const theme = home.getByTestId('theme-switch')
  const sos = home.locator('.rd-sos-button')

  for (const offline of [false, true]) {
    if (offline) {
      await context.setOffline(true)
      await expect(page.locator('.rd-offline')).toBeVisible()
    }
    const circle = (await orb.boundingBox())!
    expect(circle.x + circle.width / 2).toBeCloseTo(160, 0)
    for (const control of [theme, sos]) {
      const box = (await control.boundingBox())!
      expect(box.y + box.height).toBeLessThan(circle.y)
    }
  }
  await step(page, 'pwa-home-320-offline', 'Шар по центру, ниже темы, SOS и строки офлайна')
  await sos.click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByText('Закрыть', { exact: true })).toBeInViewport({ ratio: 1 })
  await sheet.getByRole('button', { name: 'Специалисты' }).click()
  await expect(page.locator('.page-current[data-name="people"] article a[href^="tel:"]')).toHaveCount(4)
})
