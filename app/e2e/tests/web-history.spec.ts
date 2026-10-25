import {
  closeSidebar,
  dialogInput,
  endConversation,
  expectNoHorizontalOverflow,
  expectSingleSos,
  goTo,
  historyItems,
  homeInput,
  messages,
  nav,
  openMark,
  openSidebar,
  openWebApp,
  pageTitle,
  registerAndConfirm,
  talkButton,
  uniqueEmail,
} from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

/**
 * The history of conversations: it lives in the sidebar, grouped by day, and "Все разговоры" is the
 * same list as a page of its own. One scenario for the same reason as the other web specs (one
 * sign-up), at both project sizes, so the sidebar is read as a column and through the drawer.
 *
 * The agent mock stamps every conversation with today's date, and a run cannot produce another day.
 * The older days are therefore added to the list answer on its way to the page, so the grouping is
 * checked on the real screens: the sidebar and the page both read that one list.
 */
const FIRST_MESSAGE = 'Сегодня было очень тяжело'
const TAKEAWAY = 'Первый разговор'
const DAY_MS = 24 * 60 * 60 * 1000

/** One row of the list answer (`DialogListItem`), with just what the screens read. */
interface DialogListItem {
  dialogId: string
  mode: string
  startedAt: string
  endedAt: string | null
  summary: { title: string; themes: string[]; tensionBefore: number | null; tensionAfter: number | null } | null
}

function pastConversation(id: string, title: string, agoMs: number): DialogListItem {
  const startedAt = Date.now() - agoMs
  return {
    dialogId: `e2e-${id}`,
    mode: 'vent',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + 10 * 60_000).toISOString(),
    summary: { title, themes: ['выговориться'], tensionBefore: 7, tensionAfter: 4 },
  }
}

test('история: сайдбар растёт с разговорами, «Все разговоры» делят по дням, прошлый разговор открывается', async ({
  page,
  shot,
}) => {
  test.setTimeout(180_000)
  let older: DialogListItem[] = []
  await page.route(
    (url) => url.pathname === '/api/dialogs',
    async (route) => {
      // Starting a conversation is the same path with another method; only the list is touched.
      if (route.request().method() !== 'GET' || older.length === 0) return route.fallback()
      const response = await route.fetch()
      // An expired token is answered with an error first, and the client retries after refreshing: let that through as it is.
      if (!response.ok()) return route.fulfill({ response })
      // The API wraps every answer: { status, result: { items, next } }.
      const body = (await response.json()) as { result?: { items?: DialogListItem[] } }
      if (!body.result?.items) return route.fulfill({ response, json: body })
      return route.fulfill({
        response,
        json: { ...body, result: { ...body.result, items: [...body.result.items, ...older] } },
      })
    },
  )
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-history'))
  const days = page.getByTestId('journal-list').getByRole('heading', { level: 2 })
  const rows = page.getByTestId('journal-item')

  // ── nothing yet: the sidebar says so and has no "all conversations" link ──
  await openSidebar(page)
  await expect(nav(page).getByText('Здесь появятся твои разговоры')).toBeVisible()
  await expect(historyItems(page)).toHaveCount(0)
  await expect(nav(page).getByRole('link', { name: 'Все разговоры', exact: true })).toHaveCount(0)
  await closeSidebar(page)

  await openWebApp(page, '/diary/journal')
  await expect(pageTitle(page)).toHaveText('Дневник')
  await expect(page.getByTestId('journal-empty')).toContainText('Здесь появятся твои разговоры.')
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-journal-empty')
  await page.getByTestId('journal-empty').getByRole('link', { name: 'Начать разговор' }).click()
  await expect(page).toHaveURL(/\/home$/)

  // ── a first conversation, started from the text on home ──────────────────
  await homeInput(page).fill(FIRST_MESSAGE)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant')).toHaveCount(2, { timeout: 30_000 })

  // It is in the sidebar from the first message on, with no title yet and marked as not finished.
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(1)
  await expect(historyItems(page).first()).toHaveText('Разговор')
  await expect(openMark(page)).toHaveCount(1)
  await closeSidebar(page)

  await endConversation(page, TAKEAWAY)
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(1)
  await expect(historyItems(page).first()).toHaveText(TAKEAWAY)
  await expect(openMark(page)).toHaveCount(0)
  // A finished conversation opens read-only, in the history.
  await expect(historyItems(page).first()).toHaveAttribute('href', /\/diary\/journal\/[^/]+$/)
  await expect(nav(page).getByRole('link', { name: 'Все разговоры', exact: true })).toBeVisible()
  await closeSidebar(page)

  // ── a second one, started with nothing typed ─────────────────────────────
  await goTo(page, 'Новый разговор')
  await talkButton(page).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  // Nothing typed: the conversation opens on the voice, with the greeting under the sphere.
  await expect(page.getByTestId('dialog-voice')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-caption')).not.toBeEmpty({ timeout: 30_000 })

  // The list grew by one, newest on top, both of them today's: one group.
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(2)
  await expect(historyItems(page).nth(0)).toHaveText('Разговор')
  await expect(historyItems(page).nth(0)).toHaveAttribute('href', /\/dialog\/[^/]+$/)
  await expect(historyItems(page).nth(1)).toHaveText(TAKEAWAY)
  await expect(openMark(page)).toHaveCount(1)
  await expect(nav(page).getByText('Сегодня', { exact: true })).toHaveCount(1)
  await closeSidebar(page)

  // ── all conversations: the same list as a page ───────────────────────────
  await goTo(page, 'Все разговоры')
  await expect(page).toHaveURL(/\/diary\/journal$/)
  await expect(rows).toHaveCount(2, { timeout: 30_000 })
  await expect(days).toHaveText(['Сегодня'])
  await expect(rows.nth(0)).toContainText('Не завершён')
  await expect(rows.nth(0)).toHaveAttribute('href', /\/dialog\/[^/]+$/)
  await expect(rows.nth(1)).toContainText(TAKEAWAY)
  await expect(rows.nth(1)).not.toContainText('Не завершён')
  await expect(rows.nth(1)).toHaveAttribute('href', /\/diary\/journal\/[^/]+$/)

  // ── days: yesterday, this week and long ago join today's ─────────────────
  older = [
    pastConversation('yesterday', 'Вчерашний разговор', DAY_MS),
    pastConversation('week', 'Разговор на неделе', 3 * DAY_MS),
    pastConversation('earlier', 'Давний разговор', 20 * DAY_MS),
  ]
  // The list is read again whenever the path changes and whenever the page opens.
  await goTo(page, 'Люди рядом')
  await goTo(page, 'Все разговоры')
  const labels = ['Сегодня', 'Вчера', 'Последние 7 дней', 'Ранее']
  await expect(days).toHaveText(labels)
  await expect(rows).toHaveCount(5)
  for (const [label, count] of [
    ['Сегодня', 2],
    ['Вчера', 1],
    ['Последние 7 дней', 1],
    ['Ранее', 1],
  ] as const) {
    await expect(page.getByRole('list', { name: label }).getByTestId('journal-item'), label).toHaveCount(count)
  }
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-journal-days')

  // The sidebar groups the same way, in the same order from the top.
  await openSidebar(page)
  await expect(historyItems(page)).toHaveCount(5)
  const tops: number[] = []
  for (const label of labels) {
    const heading = nav(page).getByText(label, { exact: true })
    await expect(heading, label).toHaveCount(1)
    tops.push((await heading.boundingBox())!.y)
  }
  expect(tops, 'группы в сайдбаре идут от новых к старым').toEqual([...tops].sort((a, b) => a - b))
  await closeSidebar(page)

  // ── opening them ─────────────────────────────────────────────────────────
  // A finished conversation is read-only, on a page of its own with the way back.
  await rows.filter({ hasText: TAKEAWAY }).click()
  await expect(page).toHaveURL(/\/diary\/journal\/[^/]+$/)
  await expect(pageTitle(page)).toHaveText(TAKEAWAY, { timeout: 20_000 })
  const said = page.getByTestId('journal-messages').getByTestId('dialog-message').filter({ hasText: FIRST_MESSAGE })
  await expect(said).toHaveCount(1)
  await expect(said).toHaveAttribute('data-role', 'user')
  await expectNoHorizontalOverflow(page)
  await page.getByRole('main').getByRole('link', { name: 'Все разговоры', exact: true }).click()
  await expect(page).toHaveURL(/\/diary\/journal$/)

  // One the server does not know (a stale link) says so and does not break the page.
  await rows.filter({ hasText: 'Давний разговор' }).click()
  await expect(page).toHaveURL(/\/diary\/journal\/e2e-earlier$/)
  await expect(page.getByTestId('journal-entry-error')).toBeVisible({ timeout: 20_000 })
  await expectSingleSos(page)
  await goTo(page, 'Все разговоры')
  await expect(page).toHaveURL(/\/diary\/journal$/)

  // The one that is not finished opens where it was left: in the conversation, not read-only.
  await rows.filter({ hasText: 'Не завершён' }).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
  // This tab last had it on the voice, so it opens there; the text is one tap away.
  await expect(page.getByTestId('dialog-voice')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  await expect(dialogInput(page)).toBeVisible({ timeout: 30_000 })
  await expect(messages(page, 'assistant').first()).toBeVisible({ timeout: 30_000 })
})
