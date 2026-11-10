import { button, closeSheet, openApp, registerAndConfirm, uniqueEmail } from '../support/app'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

/**
 * The crisis branch in the mobile client (PROTEUS-279, openspec crisis-safety): the sheet with "Call now", the
 * pinned call button, the safety question with quick answers. The agent is a mock that speaks the real frames.
 */
const SHEET_TITLE = 'Сейчас важно поговорить с живым человеком'
const CALL_HREF = 'tel:84959895050'

test('кризис в приложении: лист «Позвонить сейчас», закреплённая кнопка, вопрос о безопасности, 112', async ({ page, shot }) => {
  test.setTimeout(120_000)
  await clearMailbox()
  await openApp(page)
  await registerAndConfirm(page, uniqueEmail('app-crisis'))
  await button(page, 'Поговорить').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Писать текстом' }).click()
  const input = page.getByPlaceholder('Напиши, что происходит')
  await input.fill('я больше не хочу жить')
  await page.getByRole('button', { name: 'Отправить' }).click()

  await expect(page.getByText(SHEET_TITLE).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('sos-call-now')).toHaveAttribute('href', CALL_HREF)
  await expect(page.getByTestId('sos-112')).toHaveAttribute('href', 'tel:112')
  await shot(page, 'app-crisis-sheet')

  await page.getByTestId('sos-safe').click()
  await expect(page.getByTestId('sos-call-now')).toBeHidden()
  await expect(page.getByTestId('crisis-call')).toHaveAttribute('href', CALL_HREF)
  await shot(page, 'app-crisis-pinned')

  await input.fill('не знаю, что сказать')
  await page.getByRole('button', { name: 'Отправить' }).click()
  const ask = page.getByTestId('crisis-ask')
  await expect(ask.getByRole('button', { name: 'Не знаю' })).toBeVisible({ timeout: 30_000 })
  await shot(page, 'app-crisis-check')
  await ask.getByRole('button', { name: 'Не знаю' }).click()
  await expect(page.getByTestId('sos-call-now')).toBeVisible({ timeout: 30_000 })
  await closeSheet(page)
  await expect(page.getByTestId('crisis-call')).toBeVisible()
})
