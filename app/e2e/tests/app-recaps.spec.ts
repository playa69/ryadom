import type { APIRequestContext, Page } from '@playwright/test'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { APP_URL } from '../playwright.config'
import { button, openApp, openJournal, openTab, sheetButton, startAnonymously } from '../support/app'
import { ageWeekSummary, seedDialogs, seedMarks } from '../support/diary'
import { expect, test } from '../support/fixtures'
import { trackSession } from '../support/session'

/**
 * Итог разговора и итоги недели в приложении (PWA, `add-mood-diary`, D13): три способа завести итог в листе завершения,
 * разговор без итога, итог в записи журнала, итоги недели читают итоги и пересобираются, «Удалить разговор».
 */
const MANUAL_RECAP = 'Тяжёлая неделя на работе, поговорю с руководителем до пятницы.'
const EDITED_RECAP = 'Ты решил не откладывать разговор с руководителем.'
const SAID = 'Мне сегодня очень тяжело из-за работы. Давай так: поговорю с руководителем до пятницы'

async function readDiary(request: APIRequestContext, token: string) {
  const response = await request.get(`${APP_URL}/api/diary`, { headers: { Authorization: `Bearer ${token}` } })
  return ((await response.json()) as { result: DiaryApiResponse }).result
}

async function recapCount(request: APIRequestContext, token: string): Promise<number> {
  const response = await request.get(`${APP_URL}/api/recaps`, { headers: { Authorization: `Bearer ${token}` } })
  return ((await response.json()) as { result: { items: unknown[] } }).result.items.length
}

/** One conversation: opened from home, the text typed, the mock's reply waited for. */
async function talk(page: Page, text: string): Promise<void> {
  await openTab(page, 'Главная')
  await button(page, 'Поговорить').click()
  await expect(current(page).getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await current(page).getByRole('button', { name: 'Писать текстом' }).click()
  await current(page).getByPlaceholder('Напиши, что происходит').fill(text)
  await current(page).getByRole('button', { name: 'Отправить' }).click()
  await expect(current(page).locator('.message-sent')).toHaveCount(1, { timeout: 20_000 })
  await expect(current(page).locator('.message-received')).toHaveCount(2, { timeout: 30_000 })
  // Ending in the middle of a reply would only test the fallback timer.
  await page.waitForTimeout(1500)
}

/** On a wide screen the pages of earlier conversations stay in the stack: only the current one counts. */
const current = (page: Page) => page.locator('.page-current')

const sheet = (page: Page) => page.locator('.sheet-modal.modal-in')

async function openEnd(page: Page): Promise<void> {
  await current(page).getByRole('button', { name: 'Завершить разговор' }).click()
  await expect(sheet(page).getByText('Что забираешь с собой?')).toBeVisible()
}

/** «Завершить», the thank-you dialog; returns its text and leaves through «ОК». */
async function submitAndLeave(page: Page): Promise<string> {
  await sheetButton(page, 'Завершить').click()
  const done = page.locator('.dialog.modal-in')
  await expect(done).toBeVisible({ timeout: 30_000 })
  const text = (await done.textContent()) ?? ''
  await done.getByText('ОК').click()
  await expect(done).toHaveCount(0)
  return text
}

test('итог разговора в приложении: три способа, короткий разговор без итога, итоги недели, удаление', async ({ page, request, shot }) => {
  test.setTimeout(700_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  const token = () => session.accessToken()

  // ── вручную ──────────────────────────────────────────────────────────────
  await talk(page, SAID)
  await openEnd(page)
  await expect(sheet(page).getByTestId('recap-auto').locator('input')).toBeChecked()
  await sheet(page).getByTestId('takeaway-input').fill(MANUAL_RECAP)
  await shot(page, 'recap-sheet-manual')
  expect(await submitAndLeave(page)).toContain('Итог разговора сохранён в журнале')

  // ── «Предзаполнить» ──────────────────────────────────────────────────────
  await talk(page, SAID)
  await openEnd(page)
  await sheet(page).getByTestId('recap-draft').click()
  await expect(sheet(page).getByTestId('takeaway-input')).not.toHaveValue('', { timeout: 20_000 })
  expect(await recapCount(request, token())).toBe(1) // the draft saved nothing
  await sheet(page).getByTestId('takeaway-input').fill(EDITED_RECAP)
  await shot(page, 'recap-sheet-draft')
  expect(await submitAndLeave(page)).toContain('Итог разговора сохранён в журнале')

  // ── автоматически ────────────────────────────────────────────────────────
  await talk(page, SAID)
  await openEnd(page)
  await shot(page, 'recap-sheet-auto')
  expect(await submitAndLeave(page)).toContain('Итог разговора появится в журнале через минуту')

  // ── мало сказано: итога нет ──────────────────────────────────────────────
  await talk(page, 'Привет')
  await openEnd(page)
  expect(await submitAndLeave(page)).not.toContain('Итог разговора')
  await expect.poll(() => recapCount(request, token()), { timeout: 30_000 }).toBe(3)

  // ── журнал: итог в записи; у короткого разговора блока итога нет ─────────
  await openJournal(page)
  const rows = page.locator('.page-current').getByTestId('journal-item')
  await expect(rows).toHaveCount(4, { timeout: 30_000 })
  await shot(page, 'recap-journal')
  await rows.nth(3).click()
  const entry = page.locator('.page-current')
  await expect(entry.getByTestId('journal-recap-text')).toHaveText(MANUAL_RECAP, { timeout: 20_000 })
  await shot(page, 'recap-entry-manual')
  // Back from the entry to the list (on a wide screen the entry is a pane beside it and there is no way back to press).
  const back = page.locator('.page-current .navbar a.back')
  if (await back.count()) await back.first().click()
  await rows.nth(0).click()
  await expect(entry.getByTestId('journal-summary').or(entry.locator('.rd-card').first())).toBeVisible({ timeout: 20_000 })
  await expect(entry.getByTestId('journal-recap')).toHaveCount(0)
  await expect(entry.getByTestId('journal-recap-none')).toHaveCount(0)

  // ── итоги недели читают итоги разговоров ─────────────────────────────────
  const { week } = await readDiary(request, token())
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(week.start) + i * 86_400_000).toISOString().slice(0, 10))
  await seedMarks(session.userId(), days.slice(0, 3).map((date) => ({ date, mood: 3 as const })))
  if (await back.count()) await back.first().click()
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  await page.locator('.page-current').getByTestId('diary-segment-diary').click()
  const diary = page.locator('.page-current[data-name="diary"]')
  await expect
    .poll(async () => (await readDiary(request, token())).week.summary?.text ?? '', { timeout: 240_000, intervals: [5_000] })
    .toContain(MANUAL_RECAP)
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  await page.locator('.page-current').getByTestId('diary-segment-diary').click()
  await expect(diary.getByTestId('diary-week-text')).toContainText(EDITED_RECAP)
  await expect(diary).not.toContainText(/памят/i)
  await diary.getByTestId('diary-week-card').scrollIntoViewIfNeeded()
  await shot(page, 'recap-week-3')

  // ── новый итог → после паузы текст пишется заново ────────────────────────
  await talk(page, SAID)
  await openEnd(page)
  expect(await submitAndLeave(page)).toContain('появится в журнале')
  await expect.poll(() => recapCount(request, token()), { timeout: 30_000 }).toBe(4)
  await ageWeekSummary(session.userId())
  await expect
    .poll(async () => (await readDiary(request, token())).week.summary?.text ?? '', { timeout: 240_000, intervals: [5_000] })
    .not.toContain(MANUAL_RECAP) // the mock weaves the newest three recaps: the new one pushes the first out
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  await page.locator('.page-current').getByTestId('diary-segment-diary').click()
  await diary.getByTestId('diary-week-card').scrollIntoViewIfNeeded()
  await expect(diary.getByTestId('diary-week-text')).not.toContainText(MANUAL_RECAP)
  await shot(page, 'recap-week-4')

  // ── «Удалить разговор» ───────────────────────────────────────────────────
  await openJournal(page)
  await expect(rows).toHaveCount(5, { timeout: 30_000 })
  await rows.nth(0).click()
  await expect(entry.getByTestId('journal-recap')).toBeVisible({ timeout: 45_000 })
  await entry.getByTestId('journal-delete').click()
  const confirm = page.getByTestId('journal-delete-confirm')
  await expect(confirm).toContainText('Факты из него останутся')
  await expect(confirm).toContainText('Итоги недели')
  await expect(confirm).toContainText('резервных архивах хранятся до 30 дней')
  await shot(page, 'recap-delete-confirm')
  await page.getByTestId('journal-delete-confirm-yes').click()
  await expect.poll(() => recapCount(request, token())).toBe(3)
  await expect
    .poll(async () => (await readDiary(request, token())).week.summary?.text ?? '', { timeout: 240_000, intervals: [3_000] })
    .toContain(MANUAL_RECAP)
  await openTab(page, 'Главная')
  await openTab(page, 'Дневник')
  await page.locator('.page-current').getByTestId('diary-segment-diary').click()
  await diary.getByTestId('diary-week-card').scrollIntoViewIfNeeded()
  await shot(page, 'recap-week-after-delete')
})

test('журнал в приложении: пометка о не сохранённом разговоре, удаление пометки, настройка автоитога', async ({ page, request, shot }) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  await openApp(page)
  await startAnonymously(page)
  const hourAgo = new Date(Date.now() - 3_600_000)
  await seedDialogs(session.userId(), [
    {
      startedAt: new Date(hourAgo.getTime() - 86_400_000).toISOString(),
      endedAt: new Date(hourAgo.getTime() - 86_400_000 + 600_000).toISOString(),
      summary: {
        title: 'Про работу',
        themes: ['выговориться'],
        tensionBefore: null,
        tensionAfter: 4,
        recap: 'Ты говорил о работе, и после этого стало легче.',
        recapStatus: 'ready',
        recapSource: 'auto',
        recapAvailable: true,
      },
      messages: [{ role: 'user', text: 'Мне тяжело на работе, расскажу, что произошло сегодня утром' }],
    },
    { startedAt: hourAgo.toISOString(), endedAt: new Date(hourAgo.getTime() + 12 * 60_000).toISOString(), summary: null, saved: false },
  ])
  await openJournal(page)
  const rows = page.locator('.page-current').getByTestId('journal-item')
  await expect(rows).toHaveCount(2, { timeout: 30_000 })
  await expect(rows.first()).toContainText('Разговор не сохранён')
  await shot(page, 'recap-journal-unsaved')

  const setting = page.locator('.page-current').getByTestId('recap-auto-setting').locator('input')
  await expect(setting).toBeChecked()
  await setting.uncheck()
  await expect
    .poll(async () => ((await (await request.get(`${APP_URL}/api/dialog-settings`, { headers: { Authorization: `Bearer ${session.accessToken()}` } })).json()) as { result: { recapEnabled: boolean } }).result.recapEnabled)
    .toBe(false)

  await rows.first().click()
  const entry = page.locator('.page-current')
  await expect(entry.getByTestId('journal-unsaved')).toContainText('Был разговор, который не сохранён по твоему желанию')
  await expect(entry.getByTestId('journal-unsaved')).toContainText('12 мин')
  await shot(page, 'recap-unsaved-mark')
  await entry.getByTestId('journal-delete').click()
  await page.getByTestId('journal-delete-confirm-yes').click()
  await expect(page.locator('.page-current').getByTestId('journal-item')).toHaveCount(1, { timeout: 20_000 })
})
