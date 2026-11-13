import { PWA_URL } from '../playwright.config'
import { button, openApp, startAnonymously } from '../support/app'
import { expect, test } from '../support/fixtures'
import { E2E_COUNTER_ID, hitUrls, reachedGoals, refusedMetrikaRequests, ymCalls } from '../support/metrika'

/**
 * Yandex Metrika in the Framework7 client (the PWA, Telegram and the store builds run this code): the counterpart of
 * web-metrika.spec.ts. Framework7 does not change the address bar, so the screens are reported under the client's own
 * base and their route (`pageBase` of `startAnalytics`), never as the one address the page sits at.
 */
const ORIGIN = new URL(PWA_URL).origin
const DRAFT_PLACEHOLDER = 'Напиши, что происходит'

test('Метрика в PWA: запуск без записи экрана, экраны под своим маршрутом, а не под адресом страницы', async ({
  page,
}) => {
  await openApp(page)
  await expect.poll(() => hitUrls(page)).not.toHaveLength(0)

  const [init] = await ymCalls(page, 'init')
  expect(init![0]).toBe(E2E_COUNTER_ID)
  expect(init![2]).toMatchObject({ defer: true, webvisor: false, clickmap: false })

  const hits = await ymCalls(page, 'hit')
  for (const hit of hits) {
    const url = String(hit[2])
    expect(url.startsWith(`${ORIGIN}/`), url).toBe(true)
    expect(url).not.toMatch(/[?#]/)
  }
  expect(hits[0]![3]).toMatchObject({ params: { app_platform: 'web' } })
  expect(refusedMetrikaRequests(page)).toEqual([])
})

test('цели разговора в PWA: первая реплика, третья — основная цель', async ({ page }) => {
  test.setTimeout(150_000)
  await openApp(page)
  await startAnonymously(page)
  await button(page, 'Поговорить').click()
  // The conversation opens on the voice; the replies of this scenario are typed.
  await page.getByRole('button', { name: 'Писать текстом' }).click({ timeout: 30_000 })
  const input = page.getByPlaceholder(DRAFT_PLACEHOLDER)
  await expect(input).toBeVisible()

  const say = async (text: string, sent: number) => {
    await input.fill(text)
    await page.getByRole('button', { name: 'Отправить' }).click()
    await expect(page.locator('.message-sent')).toHaveCount(sent, { timeout: 20_000 })
    // The mock replies one word at a time: wait for the reply to be whole before the next one.
    await expect(page.locator('.message-received')).toHaveCount(sent + 1, { timeout: 30_000 })
  }

  await say('Первое сообщение', 1)
  await expect.poll(() => reachedGoals(page)).toEqual(['first_reply'])
  await say('Второе сообщение', 2)
  expect(await reachedGoals(page)).toEqual(['first_reply'])
  await say('Третье сообщение', 3)
  await expect.poll(async () => (await reachedGoals(page)).sort()).toEqual(['first_dialog_3_replies', 'first_reply', 'polz_3'])
  await say('Четвёртое сообщение', 4)
  expect((await reachedGoals(page)).sort()).toEqual(['first_dialog_3_replies', 'first_reply', 'polz_3'])
})
