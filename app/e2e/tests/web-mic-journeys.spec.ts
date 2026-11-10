import { openWebApp, registerAndConfirm, uniqueEmail } from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { step } from '../support/evidence'
import { answerMic, micRequests, setMicPermission, settleMic, stubMic } from '../support/mic'

// The fake device stands for a real microphone once the request is granted.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

/**
 * `openspec/changes/add-mic-permission-guide`, «Микрофон или голос недоступны»: the journey of the person from
 * the first tap on the microphone to the answer of the browser, for the good case and for each bad one.
 * A headless browser shows no system prompt: the request held open stands for the moment it is on the screen.
 */
async function openVoiceFromHome(page: import('@playwright/test').Page) {
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-mic-journey'))
  await expect(page.getByTestId('home-mic')).toBeVisible()
  await step(page, 'home', 'Главный экран: микрофон на месте, ничего не спрашивали')
}

const voiceButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Говорить голосом' })

test('путь 1 — разрешили: запрос сразу после нажатия, без экранов до него', async ({ page }) => {
  test.setTimeout(120_000)
  await stubMic(page, { outcome: 'hold', permission: 'prompt' })
  await openVoiceFromHome(page)

  await page.getByTestId('home-mic').click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
  // The request is open: here the browser puts its prompt on the screen, and the app has shown nothing of its own.
  await expect.poll(() => micRequests(page), { timeout: 30_000 }).toBe(1)
  await expect(page.getByTestId('mic-guide-steps')).toHaveCount(0)
  await step(page, 'prompt-moment', 'Момент запроса: браузер спрашивает про микрофон, своих экранов перед ним нет')

  await settleMic(page, 'grant')
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mic-guide-steps')).toHaveCount(0)
  await step(page, 'granted-listening', 'Разрешили: шар слушает, окон нет')
})

test('путь 2 — отказали в запросе: текст с уведомлением, потом инструкция, повтор, текст', async ({ page }) => {
  test.setTimeout(120_000)
  await stubMic(page, { outcome: 'hold', permission: 'prompt' })
  await openVoiceFromHome(page)

  await page.getByTestId('home-mic').click()
  await expect.poll(() => micRequests(page), { timeout: 30_000 }).toBe(1)
  await step(page, 'prompt-moment', 'Момент запроса: браузер спрашивает про микрофон')

  // Chrome remembers a refusal: from now on it answers without a prompt.
  await answerMic(page, 'NotAllowedError')
  await settleMic(page, 'NotAllowedError')
  await expect(voiceButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mic-guide-steps')).toHaveCount(0)
  await step(page, 'denied-auto-text', 'Отказали: разговор сам стартовал с главного экрана, поэтому текстовый вид и уведомление, без окна')

  await voiceButton(page).click()
  const steps = page.getByTestId('mic-guide-steps')
  await expect(steps).toBeVisible()
  await expect(page.getByTestId('mic-guide-again')).toHaveCount(0)
  await step(page, 'denied-guide', 'Человек сам нажал микрофон: окно с шагами для его места')

  await page.getByTestId('mic-guide-retry').click()
  await expect(page.getByTestId('mic-guide-again')).toBeVisible()
  await step(page, 'denied-again', '«Попробовать снова» без перемен в настройках: окно остаётся, «по-прежнему выключен»')

  await page.getByTestId('mic-guide-text').click()
  await expect(steps).toHaveCount(0)
  await expect(page.getByRole('textbox')).toBeVisible()
  await step(page, 'denied-text', '«Писать текстом»: окно закрыто, можно писать')
})

test('путь 3 — отказ запомнен браузером: запроса нет, окно сразу; включили в настройках — продолжить', async ({ page }) => {
  test.setTimeout(120_000)
  await stubMic(page, { outcome: 'NotAllowedError', permission: 'denied' })
  await openVoiceFromHome(page)

  await page.getByTestId('home-mic').click()
  await expect(voiceButton(page)).toBeVisible({ timeout: 30_000 })
  expect(await micRequests(page), 'браузер не спрашивали: отказ он помнит').toBe(0)
  await step(page, 'remembered-auto-text', 'Отказ запомнен: микрофон не запрашивали, текстовый вид с уведомлением')

  await voiceButton(page).click()
  await expect(page.getByTestId('mic-guide-steps')).toBeVisible()
  expect(await micRequests(page)).toBe(0)
  await step(page, 'remembered-guide', 'Нажали микрофон: окно сразу, системный запрос не вызывался')

  // The person goes to the settings, flips the switch and comes back.
  await answerMic(page, 'grant')
  await setMicPermission(page, 'granted')
  await expect(page.getByTestId('mic-guide-granted')).toBeVisible()
  await step(page, 'remembered-granted', 'Включили в настройках: окно само предлагает продолжить')

  await page.getByTestId('mic-guide-continue').click()
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await step(page, 'remembered-listening', 'Продолжить: шар слушает')
})

const FAILURES = [
  { key: 'no-device', name: 'NotFoundError', text: 'Микрофон не найден. Подключи его — или пиши текстом.', caption: 'Нет устройства звука' },
  { key: 'busy', name: 'NotReadableError', text: 'Микрофон занят другим приложением. Закрой его там — или пиши текстом.', caption: 'Микрофон занят другим приложением' },
  { key: 'insecure', name: 'SecurityError', text: 'Здесь микрофон включить нельзя', caption: 'Страница не защищена' },
  { key: 'other', name: 'TypeError', text: 'Не получилось включить микрофон. Можно писать текстом.', caption: 'Иной сбой' },
]

for (const failure of FAILURES) {
  test(`путь 4 — ${failure.caption.toLowerCase()}: короткое сообщение без инструкции по разрешению`, async ({ page }) => {
    test.setTimeout(120_000)
    await stubMic(page, { outcome: failure.name, permission: 'prompt' })
    await openVoiceFromHome(page)

    await page.getByTestId('home-mic').click()
    await expect(voiceButton(page)).toBeVisible({ timeout: 30_000 })
    await step(page, `${failure.key}-auto-text`, `${failure.caption}: автостарт уходит в текстовый вид с уведомлением`)

    await voiceButton(page).click()
    await expect(page.getByTestId('alert-text')).toContainText(failure.text)
    await expect(page.getByTestId('mic-guide-steps')).toHaveCount(0)
    await step(page, `${failure.key}-alert`, `${failure.caption}: окно «Голос» с причиной; шагов про разрешение нет`)
    await page.getByTestId('alert-ok').click()
  })
}

test('путь 5 — Safari не умеет спросить о разрешении: спрашиваем запросом, отказ ведёт к инструкции', async ({ page }) => {
  test.setTimeout(120_000)
  await stubMic(page, { outcome: 'NotAllowedError', permission: null })
  await openVoiceFromHome(page)

  await page.getByTestId('home-mic').click()
  await expect(voiceButton(page)).toBeVisible({ timeout: 30_000 })
  expect(await micRequests(page), 'без ответа браузера остаётся спросить запросом').toBeGreaterThan(0)
  await voiceButton(page).click()
  await expect(page.getByTestId('mic-guide-steps')).toBeVisible()
  await step(page, 'safari-guide', 'Браузер не сообщает состояние: отказ узнали запросом, окно с шагами')
})
