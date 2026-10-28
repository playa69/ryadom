import type { APIRequestContext, Page } from '@playwright/test'
import { APP_URL, AGENT_URL } from '../playwright.config'
import { button, openApp, openJournal, openTab, sheetButton, startAnonymously } from '../support/app'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'
import { trackSession } from '../support/session'

/**
 * «Не сохранять этот разговор» в приложении (PWA и Mini App, `add-unsaved-dialog`, PROTEUS-246): галочка на главной,
 * разговор без следа, пометка в журнале, потеря разговора при перезапуске агента. Агент — мок (`dev/agent-mock/server.mjs`).
 */
const SAID = 'Мне сегодня очень тяжело из-за работы. Давай так: поговорю с руководителем до пятницы'

const current = (page: Page) => page.locator('.page-current')
const sheet = (page: Page) => page.locator('.sheet-modal.modal-in')

const apiGet = async <T>(request: APIRequestContext, token: string, path: string): Promise<T> =>
  (
    (await (
      await request.get(`${APP_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { result: T }
  ).result

/** The conversation opened from home with the box ticked or not, one text reply sent, the mock's answer waited for. */
async function talkTicked(page: Page, ticked: boolean): Promise<void> {
  await openTab(page, 'Главная')
  if (ticked) await current(page).getByTestId('unsaved-toggle').check()
  await button(page, 'Поговорить').click()
  await expect(current(page).getByRole('button', { name: 'Остановить запись' })).toBeVisible({
    timeout: 30_000,
  })
  await current(page).getByRole('button', { name: 'Писать текстом' }).click()
  await current(page).getByPlaceholder('Напиши, что происходит').fill(SAID)
  await current(page).getByRole('button', { name: 'Отправить' }).click()
  await expect(current(page).locator('.message-sent')).toHaveCount(1, { timeout: 20_000 })
  await expect(current(page).locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  // Ending in the middle of a reply would only test the fallback timer.
  await page.waitForTimeout(1500)
}

test('не сохранять в приложении: галочка на главной, разговор без следа, пометка в журнале', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)

  // Память у нового аккаунта выключена, а галочка на месте.
  const home = current(page)
  await expect(home.getByTestId('incognito')).toHaveCount(0)
  await expect(home.getByTestId('unsaved')).toContainText('Не сохранять этот разговор')
  await expect(home.getByTestId('unsaved')).toContainText('Он не попадёт в журнал, итоги и память')
  await expect(home.getByTestId('unsaved-toggle')).not.toBeChecked()
  await step(
    page,
    'home-unticked',
    'Главная: под «Поговорить» галочка «Не сохранять этот разговор», память выключена',
  )
  await home.getByTestId('unsaved-toggle').check()
  await expect(home.getByTestId('unsaved-toggle')).toBeChecked()
  await step(page, 'home-ticked', 'Галочка поставлена')

  const started = page.waitForRequest((r) => r.url().endsWith('/api/dialogs') && r.method() === 'POST')
  await button(page, 'Поговорить').click()
  await expect(current(page).getByRole('button', { name: 'Остановить запись' })).toBeVisible({
    timeout: 30_000,
  })
  expect((await started).postDataJSON()).toMatchObject({ saved: false })
  expect((await started).postDataJSON()).not.toHaveProperty('memory')
  await expect(current(page).getByTestId('dialog-unsaved')).toContainText('Не сохраняется')
  await expect(current(page).getByTestId('dialog-incognito')).toHaveCount(0)
  await expect(current(page).getByTestId('unsaved-toggle')).toHaveCount(0) // после старта выбор не меняется
  await step(page, 'dialog-note', 'Разговор идёт: плашка «Не сохраняется»')

  await current(page).getByRole('button', { name: 'Писать текстом' }).click()
  await current(page).getByPlaceholder('Напиши, что происходит').fill(SAID)
  await current(page).getByRole('button', { name: 'Отправить' }).click()
  await expect(current(page).locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await page.waitForTimeout(1500)
  await expect(current(page).getByTestId('share-nav')).toHaveCount(0) // поделиться таким разговором нельзя

  // Лист завершения ничего не спрашивает.
  await current(page).getByRole('button', { name: 'Завершить разговор' }).click()
  await expect(sheet(page).getByText('Завершить разговор?')).toBeVisible()
  await expect(sheet(page).getByTestId('unsaved-end-note')).toContainText('останется только пометка')
  await expect(sheet(page).getByTestId('takeaway-input')).toHaveCount(0)
  await step(page, 'end-sheet', 'Лист завершения без полей итога и шкалы')
  await sheetButton(page, 'Завершить').click()
  const done = page.locator('.dialog.modal-in')
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done).toContainText('не сохранён')
  await step(page, 'goodbye', 'Прощальное окно: разговор завершён и не сохранён')
  await done.getByText('ОК').click()
  await expect(done).toHaveCount(0)

  await openJournal(page)
  const rows = current(page).getByTestId('journal-item')
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(rows.first()).toContainText('Разговор не сохранён')
  await expect(rows.first()).not.toContainText('Без памяти')
  await expect(rows.first()).not.toContainText('руководителем')
  await step(page, 'journal-row', 'Журнал: строка «Разговор не сохранён» без тем и текста')
  await rows.first().click()
  await expect(current(page).getByTestId('journal-unsaved')).toContainText(
    'Был разговор, который не сохранён по твоему желанию',
  )
  await expect(current(page).getByTestId('journal-delete')).toBeVisible()
  await step(
    page,
    'journal-mark',
    'Запись: карточка с датой и длительностью, единственное действие — «Удалить пометку»',
  )
  expect(await apiGet<{ items: unknown[] }>(request, session.accessToken(), '/api/recaps')).toMatchObject({
    items: [],
  })
})

test('не сохранять в приложении: перезапуск агента — «Разговор не сохранён», пометки нет', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await talkTicked(page, true)
  await expect(current(page).getByTestId('dialog-unsaved')).toBeVisible()

  // Выкат агента: сокеты рвутся, а разговор, который жил только в памяти процесса, пропадает.
  const restarted = await request.post(`${AGENT_URL}/dev/restart`)
  expect(((await restarted.json()) as { lostUnsaved: number }).lostUnsaved).toBe(1)

  await expect(current(page).getByTestId('dialog-unsaved-gone')).toBeVisible({ timeout: 30_000 })
  await expect(current(page).getByRole('heading', { name: 'Разговор не сохранён' })).toBeVisible()
  await step(page, 'agent-restart', 'Агент перезапустился: «Разговор не сохранён» и кнопка «На главную»')
  await current(page).getByText('На главную', { exact: true }).click()
  await expect(button(page, 'Поговорить')).toBeVisible()

  await openJournal(page)
  await expect(current(page).getByTestId('journal-item')).toHaveCount(0)
  expect(await apiGet<{ items: unknown[] }>(request, session.accessToken(), '/api/dialogs')).toMatchObject({
    items: [],
  })
})
