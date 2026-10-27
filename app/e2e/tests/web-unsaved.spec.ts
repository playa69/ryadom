import type { APIRequestContext, Page } from '@playwright/test'
import { APP_URL, AGENT_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'
import { step } from '../support/evidence'
import { trackSession } from '../support/session'
import {
  dialogInput,
  goTo,
  homeInput,
  messages,
  modal,
  modalButton,
  openProfile,
  openWebApp,
  startAnonymously,
} from '../support/web'

/**
 * «Не сохранять этот разговор» в вебе (`openspec/changes/add-unsaved-dialog`, PROTEUS-246): галочка на главной, разговор без следа,
 * пометка в журнале, потеря разговора при перезапуске агента. «Без памяти» (`memory: off`) — другой выбор: разговор записывается
 * и у него есть итог. Агент — мок (`dev/agent-mock/server.mjs`); то, что в базу ничего не пишется, проверяют тесты агента.
 */
const SAID = 'Мне сегодня очень тяжело из-за работы. Давай так: поговорю с руководителем до пятницы'

const apiGet = async <T>(request: APIRequestContext, token: string, path: string): Promise<T> =>
  (
    (await (
      await request.get(`${APP_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { result: T }
  ).result

/** The conversation is typed on home and answered by the mock; the page stays on it. */
async function say(page: Page, text: string): Promise<void> {
  await homeInput(page).fill(text)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(() => messages(page, 'assistant').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  // Ending in the middle of a reply would only test the fallback timer.
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
}

test('не сохранять: галочка на главной, разговор без следа, пометка в журнале', async ({ page, request }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openWebApp(page)
  await startAnonymously(page)
  await expect(homeInput(page)).toBeVisible()

  // Память у нового аккаунта выключена, а галочка на месте: она не зависит от памяти.
  const tick = page.getByTestId('unsaved-toggle')
  await expect(page.getByTestId('incognito')).toHaveCount(0)
  await expect(page.getByTestId('unsaved')).toContainText('Не сохранять этот разговор')
  await expect(page.getByTestId('unsaved')).toContainText('Он не попадёт в журнал, итоги и память')
  await expect(tick).not.toBeChecked()
  await step(
    page,
    'home-unticked',
    'Главная: рядом с «Поговорить» галочка «Не сохранять этот разговор», память выключена',
  )

  await tick.click()
  await expect(tick).toBeChecked()
  await step(page, 'home-ticked', 'Галочка поставлена')

  const started = page.waitForRequest((r) => r.url().endsWith('/api/dialogs') && r.method() === 'POST')
  await say(page, SAID)
  // Только saved: false, «Без памяти» не задето.
  expect((await started).postDataJSON()).toMatchObject({ saved: false })
  expect((await started).postDataJSON()).not.toHaveProperty('memory')

  // Пометка вместо «Без памяти», ни памяти, ни ссылки «Поделиться»; сказанное при этом видно на экране.
  await expect(page.getByTestId('dialog-unsaved')).toContainText('Не сохраняется')
  await expect(page.getByTestId('dialog-incognito')).toHaveCount(0)
  await expect(page.getByTestId('dialog-share')).toHaveCount(0)
  await expect(page.getByTestId('unsaved-toggle')).toHaveCount(0) // после старта выбор не меняется
  await expect(messages(page, 'user').first()).toContainText('руководителем')
  await step(
    page,
    'dialog-note',
    'Разговор идёт: плашка «Не сохраняется», нет «Поделиться» и галочки, реплики видны',
  )

  // Лист завершения ничего не спрашивает: ни «что забираешь», ни шкалы.
  await page.getByTestId('dialog-end').click()
  await expect(modal(page).getByRole('heading', { name: 'Завершить разговор?' })).toBeVisible()
  await expect(modal(page).getByTestId('unsaved-end-note')).toContainText('останется только пометка')
  await expect(page.getByTestId('takeaway-input')).toHaveCount(0)
  await expect(page.getByTestId('tension-option')).toHaveCount(0)
  await step(page, 'end-sheet', 'Лист завершения без полей итога и шкалы')
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByTestId('alert-text')).toContainText('не сохранён')
  await step(page, 'goodbye', 'Прощальное окно: разговор завершён и не сохранён')
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  // Галочка к следующему разговору снова снята.
  await expect(page.getByTestId('unsaved-toggle')).not.toBeChecked()

  // В журнале пометка без текста; итога нет ни у списка итогов, ни в записи.
  await openWebApp(page, '/diary/journal')
  const rows = page.getByTestId('journal-item')
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(rows.first()).toContainText('Разговор не сохранён')
  await expect(rows.first()).not.toContainText('Без памяти')
  await expect(rows.first()).not.toContainText('руководителем')
  await step(page, 'journal-row', 'Журнал: строка «Разговор не сохранён» без тем и текста')
  await rows.first().click()
  await expect(page.getByTestId('journal-unsaved')).toContainText(
    'Был разговор, который не сохранён по твоему желанию',
  )
  await expect(page.getByTestId('journal-messages')).toHaveCount(0)
  await expect(page.getByTestId('journal-delete')).toBeVisible()
  await step(
    page,
    'journal-mark',
    'Запись: карточка с датой и длительностью, единственное действие — «Удалить пометку»',
  )
  expect(await apiGet<{ items: unknown[] }>(request, session.accessToken(), '/api/recaps')).toMatchObject({
    items: [],
  })
})

test('не сохранять: перезапуск агента — «Разговор не сохранён», пометки нет', async ({ page, request }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openWebApp(page)
  await startAnonymously(page)
  await page.getByTestId('unsaved-toggle').click()
  await say(page, SAID)
  await expect(dialogInput(page)).toBeVisible()
  await expect(page.getByTestId('dialog-unsaved')).toBeVisible()

  // Выкат агента: сокеты рвутся, а разговор, который жил только в памяти процесса, пропадает.
  const restarted = await request.post(`${AGENT_URL}/dev/restart`)
  expect(((await restarted.json()) as { lostUnsaved: number }).lostUnsaved).toBe(1)

  await expect(page.getByTestId('dialog-unsaved-gone')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Разговор не сохранён' })).toBeVisible()
  await step(page, 'agent-restart', 'Агент перезапустился: «Разговор не сохранён» и кнопка «На главную»')

  await page.getByRole('link', { name: 'На главную', exact: true }).click()
  await expect(page).toHaveURL(/\/home$/)
  await openWebApp(page, '/diary/journal')
  await expect(page.getByTestId('journal-item')).toHaveCount(0)
  await step(page, 'journal-empty', 'В журнале ничего нет: пометки у потерянного разговора нет')
  expect(await apiGet<{ items: unknown[] }>(request, session.accessToken(), '/api/dialogs')).toMatchObject({
    items: [],
  })
})

test('«Без памяти» — не «не сохранять»: разговор записан, у него есть итог', async ({ page, request }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openWebApp(page)
  await startAnonymously(page)
  // Память включена через её лист согласия: только тогда есть переключатель «Без памяти».
  await openProfile(page)
  await page.getByTestId('row-memory').click()
  await expect(page).toHaveURL(/\/profile\/memory$/)
  const memorySwitch = page.getByTestId('memory-switch').getByRole('checkbox')
  await memorySwitch.click()
  await modalButton(page, 'Включить память').click()
  await expect(memorySwitch).toBeChecked()

  await goTo(page, 'Новый разговор')
  await page.getByTestId('incognito-toggle').click()
  await expect(page.getByTestId('unsaved-toggle')).not.toBeChecked() // два выбора независимы
  const started = page.waitForRequest((r) => r.url().endsWith('/api/dialogs') && r.method() === 'POST')
  await say(page, SAID)
  expect((await started).postDataJSON()).toMatchObject({ memory: 'off' })
  expect((await started).postDataJSON()).not.toHaveProperty('saved')
  await expect(page.getByTestId('dialog-incognito')).toContainText('Без памяти')
  await expect(page.getByTestId('dialog-unsaved')).toHaveCount(0)
  await expect(page.getByTestId('dialog-share')).toBeVisible() // обычный разговор: ссылкой делиться можно

  await page.getByTestId('dialog-end').click()
  await expect(modal(page).getByRole('heading', { name: 'Что забираешь с собой?' })).toBeVisible()
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByTestId('alert-ok').click()

  // Итог подводится в фоне (мок отвечает через несколько секунд), как у любого разговора.
  await expect
    .poll(
      async () =>
        (await apiGet<{ items: unknown[] }>(request, session.accessToken(), '/api/recaps')).items.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1)
  await openWebApp(page, '/diary/journal')
  const rows = page.getByTestId('journal-item')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).not.toContainText('Разговор не сохранён')
  await expect(rows.first().getByTestId('journal-incognito')).toContainText('Без памяти')
  await rows.first().click()
  await expect(page.getByTestId('journal-messages')).toBeVisible()
  await step(
    page,
    'without-memory-entry',
    '«Без памяти»: запись с текстом и итогом, как у обычного разговора',
  )
})
