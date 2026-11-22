import type { Locator } from '@playwright/test'
import { PWA_URL, WEBAPP_URL } from '../playwright.config'
import { openApp, startAnonymously } from '../support/app'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'

const SPECIALISTS_LINK = 'Не кризис, но хочется поговорить с живым человеком? → Специалисты'
const CREDIT = 'Создано при участии гештальт-терапевтов'

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
})

async function expectSpecialists(section: Locator) {
  await expect(section.getByText(/Консультации проходят по записи/)).toBeVisible()
  await expect(section.getByRole('heading', { level: 3 })).toHaveCount(4)
  const phones = section.getByRole('link')
  await expect(phones).toHaveCount(4)
  for (const phone of await phones.all()) {
    await expect(phone).toHaveAttribute('href', /^tel:\+7\d{10}$/)
  }
}

test('лендинг показывает вклад терапевтов и ведёт от линий помощи к специалистам', async ({ page }) => {
  // `update-landing-and-people`, «Участие терапевтов и число разговоров на лендинге», REQ-SAFE-04.
  await page.goto('/')
  await expect(page.getByText('Создано при участии практикующих гештальт-терапевтов')).toBeVisible()
  await expect(page.getByText('Выслушано более 14 000 разговоров')).toBeVisible()
  const contributors = page.locator('#modes + #contributors:has(+ #safety)')
  await expect(contributors.getByRole('heading', { name: 'Кто помогал создавать' })).toBeVisible()
  await expect(contributors).toContainText('гештальт-дневником и кризисным протоколом')
  await step(page, 'landing-credit', 'Участие терапевтов на лендинге', { fullPage: true })
  const safety = page.locator('#safety')
  await expect(safety.locator('a[href="tel:112"]')).toBeVisible()
  const specialists = safety.getByRole('link', { name: SPECIALISTS_LINK })
  await expect(specialists).toHaveAttribute('href', `${WEBAPP_URL}/people#specialists`)
})

test('веб: вход и переход из SOS в раздел специалистов без сессии', async ({ page }) => {
  // `update-landing-and-people`, «Путь из SOS к плановой консультации», REQ-CARE-03 и REQ-ACC-01.
  await page.goto(`${WEBAPP_URL}/login`)
  await expect(page.getByText(CREDIT)).toBeVisible()
  await step(page, 'web-login-credit', 'Строка об участии терапевтов при входе')
  await page.goto(`${WEBAPP_URL}/home`)
  await page.getByRole('button', { name: 'SOS' }).click()
  const sheet = page.getByRole('dialog', { name: 'Если сейчас тяжело' })
  await expect(sheet.locator('a[href="tel:112"]')).toBeVisible()
  await step(page, 'web-sos', 'Круглосуточные линии и ссылка на специалистов')
  await sheet.getByRole('link', { name: SPECIALISTS_LINK }).click()
  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(/\/people#specialists$/)
  await expect(page.getByRole('heading', { name: 'Специалисты' })).toBeInViewport()
  await expectSpecialists(page.getByRole('region', { name: 'Специалисты' }))
  await step(page, 'web-specialists', 'Раздел «Специалисты»')
})

test('PWA: шапка первого экрана и переход из SOS без сети', async ({ page, context }) => {
  // `update-landing-and-people`, «Компоновка первого экрана PWA» и «Путь из SOS к плановой консультации», REQ-CARE-03.
  await page.goto(PWA_URL)
  const current = page.locator('.page-current')
  await current.getByTestId('have-account').click()
  await expect(current.getByText(CREDIT)).toBeVisible()
  await step(page, 'pwa-login-credit', 'Строка об участии терапевтов при входе в PWA')
  await page.goto(PWA_URL)
  await expect(current.getByTestId('hello-caption')).toBeVisible()
  await context.setOffline(true)
  const offline = page.getByRole('status').filter({ hasText: 'Нет сети' })
  await expect(offline).toBeVisible()
  const header = current.locator('.rd-welcome-top')
  const sos = header.getByRole('button', { name: 'SOS' })
  for (const control of await header.getByRole('button').or(header.getByRole('switch')).all()) {
    await expect(control).toBeInViewport()
    const box = (await control.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual((await offline.boundingBox())!.height)
  }
  const plaque = (await current.getByTestId('hello-plaque').boundingBox())!
  const actions = (await current.locator('.rd-first-hello-actions').boundingBox())!
  const center = page.viewportSize()!.width / 2
  expect(plaque.x + plaque.width / 2).toBeCloseTo(center, 0)
  expect(actions.x + actions.width / 2).toBeCloseTo(center, 0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width)
  await step(page, 'pwa-entry-offline', 'Кнопки шапки доступны под плашкой офлайна')
  await sos.click()
  const sheet = page.locator('.sheet-modal.modal-in', { hasText: 'Если сейчас тяжело' })
  await expect(sheet.locator('a[href="tel:112"]')).toBeVisible()
  await step(page, 'pwa-sos', 'Линии помощи и ссылка на специалистов без сети')
  await sheet.getByRole('link', { name: SPECIALISTS_LINK }).click()
  await expect(sheet).toBeHidden()
  const heading = current.getByRole('heading', { name: 'Специалисты' })
  await expect(heading).toBeFocused()
  await expect(heading).toBeInViewport()
  const navbar = (await current.locator('.navbar').boundingBox())!
  expect(navbar.y).toBeGreaterThanOrEqual((await offline.boundingBox())!.height)
  expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(navbar.y + navbar.height)
  await expectSpecialists(current.getByRole('region', { name: 'Специалисты' }))
  await step(page, 'pwa-specialists', 'Раздел «Специалисты» доступен без сети')
  await current.locator('.navbar .back').click()
  await expect(current.getByTestId('hello-caption')).toBeVisible()
})

test('PWA: шар и кнопка начала разговора на главной после входа', async ({ page }, testInfo) => {
  // `update-landing-and-people`, «Компоновка первого экрана PWA», REQ-DLG-01.
  await openApp(page)
  await startAnonymously(page)

  const home = page.locator('.page-current')
  const voice = home.getByTestId('home-start-voice')
  const keyboard = home.getByTestId('home-start-text')
  await expect(keyboard).toBeInViewport()
  if (testInfo.project.name === 'mobile') {
    const orb = (await home.locator('.rd-breathing').boundingBox())!
    const primary = (await voice.boundingBox())!
    const sos = (await home.getByRole('button', { name: 'SOS' }).boundingBox())!
    const theme = (await home.getByRole('switch').boundingBox())!
    expect(orb.y).toBeGreaterThanOrEqual(Math.max(sos.y + sos.height, theme.y + theme.height))
    expect(primary.x + primary.width / 2).toBeCloseTo(orb.x + orb.width / 2, 0)
  }
  await step(page, 'pwa-home', 'Главная после входа: шар и кнопка разговора на телефоне на одной оси')
})
