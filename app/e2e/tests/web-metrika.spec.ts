import { WEBAPP_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'
import { E2E_COUNTER_ID, hitUrls, reachedGoals, refusedMetrikaRequests, ymCalls } from '../support/metrika'
import { dialogInput, homeInput, messages, openWebApp, startAnonymously, watchCsp } from '../support/web'

/**
 * Yandex Metrika in the web app (spec `product-analytics`: «Яндекс Метрика: включение и состав», «…: что передаётся»,
 * «Цели Метрики»). The tag is a stand-in (support/metrika.ts): what is checked is what the app asks it to do, and
 * that nothing reaches a real counter. The stack's API names a made-up counter and allows recording and the click
 * map, so «in the app they stay off» is shown with the permission given.
 */
const ORIGIN = new URL(WEBAPP_URL).origin

test('Метрика в вебе: запуск без записи экрана, хит с очищенным адресом и параметры визита', async ({
  page,
}) => {
  const violations = await watchCsp(page)
  // The address of the password-reset screen carries a secret code; the fragment is where a launch of Telegram puts its data.
  await openWebApp(
    page,
    '/reset-password?code=SECRET-E2E-CODE&utm_source=mail#tgWebAppData=SECRET-E2E-FRAGMENT',
  )
  await expect.poll(() => hitUrls(page)).not.toHaveLength(0)

  const [init] = await ymCalls(page, 'init')
  expect(init![0]).toBe(E2E_COUNTER_ID)
  // The environment allows both; in the app neither runs. No page view of the tag's own: the app sends them.
  expect(init![2]).toMatchObject({ defer: true, webvisor: false, clickmap: false, trackLinks: false })

  const hits = await ymCalls(page, 'hit')
  expect(hits[0]![2]).toBe(`${ORIGIN}/reset-password?utm_source=mail`)
  expect(hits[0]![3]).toMatchObject({ params: { app_platform: 'web' } })
  const everything = JSON.stringify(await ymCalls(page))
  expect(everything).not.toContain('SECRET-E2E-CODE')
  expect(everything).not.toContain('SECRET-E2E-FRAGMENT')
  expect(refusedMetrikaRequests(page), 'тег не ходил никуда, кроме заглушки').toEqual([])
  expect(await violations(), 'политика безопасности пропускает тег').toEqual([])
})

test('Метрика в вебе: переход между экранами — новый хит с прежним адресом как источником', async ({
  page,
}) => {
  await openWebApp(page, '/home')
  await expect.poll(() => hitUrls(page)).toEqual([`${ORIGIN}/home`])
  await startAnonymously(page)
  await expect(homeInput(page)).toBeVisible()
  const hits = await ymCalls(page, 'hit')
  expect(hits.length).toBeGreaterThan(1)
  expect(String(hits.at(-1)![2])).toMatch(new RegExp(`^${ORIGIN}/`))
  // Each hit names the one before it, the first has no source inside the app.
  expect(hits.at(-1)![3]).toMatchObject({ referer: String(hits.at(-2)![2]) })
})

test('Метрика в вебе: отказ от аналитики на устройстве — тег не загружается', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ryadom.analytics.optout', '1'))
  await openWebApp(page, '/home')
  await page.waitForTimeout(1500)
  expect(await page.evaluate(() => typeof (window as unknown as { ym?: unknown }).ym)).toBe('undefined')
  expect(await ymCalls(page)).toEqual([])
})

test('Метрика в вебе: Do Not Track — тег не загружается', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' }))
  await openWebApp(page, '/home')
  await page.waitForTimeout(1500)
  expect(await page.evaluate(() => typeof (window as unknown as { ym?: unknown }).ym)).toBe('undefined')
  expect(await ymCalls(page)).toEqual([])
})

test('цели разговора: первая реплика, третья — основная цель, четвёртая её не повторяет', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await openWebApp(page)
  await startAnonymously(page)

  const settled = async (assistantReplies: number) => {
    await expect(messages(page, 'assistant')).toHaveCount(assistantReplies, { timeout: 30_000 })
    await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  }

  await homeInput(page).fill('Сегодня было тяжело')
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  // A typed reply counts when the server has accepted it: the goal comes with the reply, not before it.
  await settled(2)
  await expect.poll(() => reachedGoals(page)).toEqual(['first_reply'])

  await dialogInput(page).fill('Второе сообщение')
  await dialogInput(page).press('Enter')
  await settled(3)
  expect(await reachedGoals(page), 'вторая реплика целей не даёт').toEqual(['first_reply'])

  await dialogInput(page).fill('Третье сообщение')
  await dialogInput(page).press('Enter')
  await settled(4)
  await expect.poll(async () => (await reachedGoals(page)).sort()).toEqual(['first_dialog_3_replies', 'first_reply', 'polz_3'])

  await dialogInput(page).fill('Четвёртое сообщение')
  await dialogInput(page).press('Enter')
  await settled(5)
  expect((await reachedGoals(page)).sort(), 'четвёртая реплика основную цель не повторяет').toEqual([
    'first_dialog_3_replies',
    'first_reply',
    'polz_3',
  ])
  // Nothing of what was said went into the goals.
  expect(JSON.stringify(await ymCalls(page))).not.toMatch(/тяжело|сообщение/)
})
