import { APP_URL } from '../playwright.config'
import { clearMailbox } from '../support/mail'
import { ageWeekSummary, seedDialogs, seedMarks } from '../support/diary'
import { trackSession } from '../support/session'
import { expect, test } from '../support/fixtures'
import {
  homeInput,
  messages,
  modal,
  modalButton,
  openWebApp,
  registerAndConfirm,
  uniqueEmail,
} from '../support/web'
import type { Page } from '@playwright/test'

/**
 * Итог разговора и итоги недели (`add-mood-diary`, D13): человек завершает разговор, итог подводится одним из трёх способов
 * (вручную, «Предзаполнить», автоматически), потом пересобираются итоги недели. Всё внутри дневника, память не участвует.
 * Разговор без итога (мало сказано, кризис) в итоги недели не попадает. Удаление разговора пересобирает неделю.
 */
const MANUAL_RECAP = 'Тяжёлая неделя на работе, поговорю с руководителем до пятницы.'
const EDITED_RECAP = 'Ты решил не откладывать разговор с руководителем.'
const SAID = 'Мне сегодня очень тяжело из-за работы. Давай так: поговорю с руководителем до пятницы'
const CRISIS = 'не хочу жить, и мне очень тяжело, не знаю, что делать дальше'

interface DiaryResult {
  week: { start: string; summary: { text: string } | null }
}

/** One conversation: typed on home, answered by the mock; the page stays on the conversation. */
async function talk(page: Page, text: string): Promise<void> {
  await openWebApp(page, '/home')
  await homeInput(page).fill(text)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\//, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(() => messages(page, 'assistant').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  // Ending in the middle of a reply would only test the fallback timer.
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
}

async function openEnd(page: Page): Promise<void> {
  await page.getByTestId('dialog-end').click()
  await expect(modal(page).getByRole('heading', { name: 'Что забираешь с собой?' })).toBeVisible()
}

/** Presses «Завершить» and leaves through the thank-you alert; returns the alert's text. */
async function submitAndLeave(page: Page): Promise<string> {
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({ timeout: 30_000 })
  const text = (await page.getByTestId('alert-text').textContent()) ?? ''
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  return text
}

test('итог разговора: три способа, разговоры без итога, итоги недели читают итоги и пересобираются, удаление разговора', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(600_000)
  await clearMailbox()
  const session = trackSession(page)
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-recaps'))
  const auth = () => ({ Authorization: `Bearer ${session.accessToken()}` })
  const readDiary = async () => ((await (await request.get(`${APP_URL}/api/diary`, { headers: auth() })).json()) as { result: DiaryResult }).result
  const recapList = async () =>
    ((await (await request.get(`${APP_URL}/api/recaps`, { headers: auth() })).json()) as { result: { items: { dialogId: string }[] } }).result.items

  // ── 1. вручную ───────────────────────────────────────────────────────────
  await talk(page, SAID)
  await openEnd(page)
  // «Подводить итог автоматически» включена по умолчанию, поля итога скрыты.
  await expect(page.getByTestId('recap-auto').locator('input')).toBeChecked()
  await page.getByTestId('takeaway-input').fill(MANUAL_RECAP)
  await shot(page, 'web-recap-sheet-manual')
  expect(await submitAndLeave(page)).toContain('Итог разговора сохранён в журнале')

  // ── 2. «Предзаполнить»: черновик, правка, сохранение ─────────────────────
  await talk(page, SAID)
  await openEnd(page)
  await page.getByTestId('recap-draft').click()
  await expect(page.getByTestId('takeaway-input')).not.toHaveValue('', { timeout: 20_000 })
  // Черновик ничего не сохранил: итогов пока один.
  expect(await recapList()).toHaveLength(1)
  await page.getByTestId('takeaway-input').fill(EDITED_RECAP)
  await shot(page, 'web-recap-sheet-draft')
  expect(await submitAndLeave(page)).toContain('Итог разговора сохранён в журнале')

  // ── 3. автоматически ─────────────────────────────────────────────────────
  await talk(page, SAID)
  await openEnd(page)
  await shot(page, 'web-recap-sheet-auto')
  expect(await submitAndLeave(page)).toContain('Итог разговора появится в журнале через минуту')

  // ── 4. мало сказано и 5. кризис: итога нет ───────────────────────────────
  await talk(page, 'Привет')
  await openEnd(page)
  expect(await submitAndLeave(page)).not.toContain('Итог')
  await talk(page, CRISIS)
  await expect(modal(page).getByRole('heading', { name: 'Если сейчас тяжело' })).toBeVisible({ timeout: 30_000 })
  await modalButton(page, 'Закрыть').click()
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await openEnd(page)
  expect(await submitAndLeave(page)).not.toContain('Итог')

  // Агент отдаёт итоги только трёх разговоров.
  await expect.poll(async () => (await recapList()).length, { timeout: 30_000 }).toBe(3)

  // ── журнал: итог в записях, у разговоров без итога блока нет ─────────────
  await openWebApp(page, '/diary/journal')
  const rows = page.getByTestId('journal-item')
  await expect(rows).toHaveCount(5, { timeout: 30_000 })
  await shot(page, 'web-recap-journal')
  // Список идёт от новых к старым: кризис, «Привет», автоитог, черновик, вручную.
  await rows.nth(4).click()
  await expect(page.getByTestId('journal-recap-text')).toHaveText(MANUAL_RECAP, { timeout: 20_000 })
  await shot(page, 'web-recap-entry-manual')
  await page.goBack()
  await rows.nth(2).click()
  // Автоитог готов через несколько секунд: «Итог появится через минуту» сменяется итогом (запись перечитывает себя).
  await expect(page.getByTestId('journal-recap')).toBeVisible({ timeout: 45_000 })
  await expect(page.getByTestId('journal-recap-text')).toContainText('Ты рассказал')
  await shot(page, 'web-recap-entry-auto')
  await page.goBack()
  for (const index of [1, 0]) {
    await rows.nth(index).click()
    await expect(page.getByTestId('journal-summary')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('journal-recap')).toHaveCount(0)
    await expect(page.getByTestId('journal-recap-none')).toHaveCount(0)
    await expect(page.getByTestId('journal-recap-pending')).toHaveCount(0)
    if (index === 0) await shot(page, 'web-recap-entry-crisis')
    await page.goBack()
  }

  // ── итоги недели читают три итога: отметки трёх дней — и текст пишется сам ─
  const { week } = await readDiary()
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(week.start) + i * 86_400_000).toISOString().slice(0, 10))
  await seedMarks(session.userId(), days.slice(0, 3).map((date) => ({ date, mood: 3 as const })))
  await openWebApp(page, '/diary')
  await expect
    .poll(async () => (await readDiary()).week.summary?.text ?? '', { timeout: 240_000, intervals: [5_000] })
    .toContain('работа и дела')
  await openWebApp(page, '/diary')
  await expect(page.getByTestId('diary-week-text')).toContainText('работа и дела')
  await expect(page.getByTestId('diary-week-text')).not.toContainText('руководителем') // no quotes of a recap
  // На странице дневника нет ни «Памяти», ни событий недели.
  await expect(page.getByRole('main')).not.toContainText(/памят/i)
  await page.getByTestId('diary-week-card').scrollIntoViewIfNeeded()
  await shot(page, 'web-recap-week-3')

  // ── новый итог делает текст устаревшим: после паузы он пишется заново ─────
  await talk(page, SAID)
  await openEnd(page)
  expect(await submitAndLeave(page)).toContain('появится в журнале')
  await expect.poll(async () => (await recapList()).length, { timeout: 30_000 }).toBe(4)
  await ageWeekSummary(session.userId())
  await expect
    .poll(async () => (await readDiary()).week.summary?.text ?? '', { timeout: 240_000, intervals: [5_000] })
    .toContain('работа и дела')
  await openWebApp(page, '/diary')
  await expect(page.getByTestId('diary-week-text')).not.toContainText('руководителем')
  await page.getByTestId('diary-week-card').scrollIntoViewIfNeeded()
  await shot(page, 'web-recap-week-4')

  // ── «Удалить разговор»: подтверждение, итоги недели пересобираются без него ─
  await openWebApp(page, '/diary/journal')
  await expect(rows).toHaveCount(6, { timeout: 30_000 })
  await rows.nth(0).click()
  await expect(page.getByTestId('journal-recap')).toBeVisible({ timeout: 45_000 })
  await page.getByTestId('journal-delete').click()
  const confirm = page.getByTestId('journal-delete-confirm')
  await expect(confirm).toContainText('Факты из него останутся')
  await expect(confirm).toContainText('Итоги недели')
  await expect(confirm).toContainText('резервных архивах хранятся до 30 дней')
  await shot(page, 'web-recap-delete-confirm')
  await page.getByTestId('journal-delete-confirm-yes').click()
  await expect(page).toHaveURL(/\/diary\/journal$/)
  await expect(rows).toHaveCount(5)
  await expect.poll(async () => (await recapList()).length).toBe(3)
  // Текст недели пропал сразу и пишется заново уже без удалённого разговора.
  await expect
    .poll(async () => (await readDiary()).week.summary?.text ?? '', { timeout: 240_000, intervals: [3_000] })
    .toContain('работа и дела')
  await openWebApp(page, '/diary')
  await expect(page.getByTestId('diary-week-text')).toContainText('работа и дела')
  await expect(page.getByTestId('diary-week-text')).not.toContainText('руководителем') // no quotes of a recap
  await page.getByTestId('diary-week-card').scrollIntoViewIfNeeded()
  await shot(page, 'web-recap-week-after-delete')
})

test('журнал: пометка о не сохранённом разговоре, удаление пометки; «Подводить итог автоматически» в журнале', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(180_000)
  await clearMailbox()
  const session = trackSession(page)
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-unsaved'))
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
  await openWebApp(page, '/diary/journal')
  const rows = page.getByTestId('journal-item')
  await expect(rows).toHaveCount(2, { timeout: 30_000 })
  await expect(rows.first()).toContainText('Разговор не сохранён')
  await shot(page, 'web-recap-journal-unsaved')

  // Настройка живёт в журнале, отдельно от памяти.
  const setting = page.getByTestId('recap-auto-setting').locator('input')
  await expect(setting).toBeChecked()
  await setting.uncheck()
  await expect
    .poll(async () => ((await (await request.get(`${APP_URL}/api/dialog-settings`, { headers: { Authorization: `Bearer ${session.accessToken()}` } })).json()) as { result: { recapEnabled: boolean } }).result.recapEnabled)
    .toBe(false)
  await page.reload()
  await expect(page.getByTestId('recap-auto-setting').locator('input')).not.toBeChecked()

  await rows.first().click()
  await expect(page.getByTestId('journal-unsaved')).toContainText('Был разговор, который не сохранён по твоему желанию')
  await expect(page.getByTestId('journal-unsaved')).toContainText('12 мин')
  await expect(page.getByTestId('journal-messages')).toHaveCount(0)
  await shot(page, 'web-recap-unsaved-mark')
  await page.getByTestId('journal-delete').click()
  await page.getByTestId('journal-delete-confirm-yes').click()
  await expect(page).toHaveURL(/\/diary\/journal$/)
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).not.toContainText('не сохранён')
})
