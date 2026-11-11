import type { APIRequestContext, Page } from '@playwright/test'
import { APP_URL, AGENT_URL } from '../playwright.config'
import { button, openApp, openJournal, sheetButton, startAnonymously } from '../support/app'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'
import { trackSession } from '../support/session'

/**
 * `openspec/changes/remove-unsaved-dialog-option`, «Галочка «Не сохранять этот разговор»».
 * В актуальном общем клиенте галочки больше нет. Совместимость несохраняемого режима
 * проверяется изменением стартового запроса до `saved: false`, как от старого клиента.
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

async function legacyUnsavedStart(page: Page): Promise<void> {
  await page.route('**/api/dialogs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const original = route.request().postDataJSON() as Record<string, unknown>
    const response = await route.fetch({ postData: { ...original, saved: false } })
    expect(response.status(), 'старт несохраняемого разговора старым клиентом').toBe(200)
    const body = (await response.json()) as { status: boolean; result: { saved?: boolean } }
    expect(body.status).toBe(true)
    expect(body.result.saved).toBe(false)
    await route.fulfill({ response, json: body })
  })
}

async function startFromHome(page: Page): Promise<void> {
  await button(page, 'Поговорить').click()
  await expect(current(page).getByRole('button', { name: 'Остановить запись' })).toBeVisible({
    timeout: 30_000,
  })
}

async function sayInDialog(page: Page): Promise<void> {
  await current(page).getByRole('button', { name: 'Писать текстом' }).click()
  await current(page).getByPlaceholder('Напиши, что происходит').fill(SAID)
  await current(page).getByRole('button', { name: 'Отправить' }).click()
  await expect(current(page).locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  await page.waitForTimeout(1500)
}

test('PWA: галочки нет, старый несохраняемый разговор открывается и завершается как прежде', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)

  const home = current(page)
  await expect(home.getByTestId('incognito')).toHaveCount(0)
  await expect(home.getByTestId('unsaved')).toHaveCount(0)
  await expect(home.getByTestId('unsaved-toggle')).toHaveCount(0)
  await step(page, 'home-no-unsaved', 'Главная PWA: галочки «Не сохранять этот разговор» нет')

  await legacyUnsavedStart(page)
  await startFromHome(page)
  await expect(current(page).getByTestId('dialog-unsaved')).toContainText('Не сохраняется')
  await expect(current(page).getByTestId('dialog-incognito')).toHaveCount(0)
  await expect(current(page).getByTestId('unsaved-toggle')).toHaveCount(0)
  await step(page, 'dialog-note', 'Старый разговор в PWA: плашка «Не сохраняется»')
  await sayInDialog(page)
  await expect(current(page).getByTestId('share-nav')).toHaveCount(0)

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

test('PWA: старый несохраняемый разговор пропадает при перезапуске агента', async ({ page, request }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  await legacyUnsavedStart(page)
  await startFromHome(page)
  await expect(current(page).getByTestId('dialog-unsaved')).toContainText('Не сохраняется')
  await sayInDialog(page)

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
