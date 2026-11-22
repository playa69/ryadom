import { expect, test } from '@playwright/test'
import { PWA_URL, WEBAPP_URL } from '../playwright.config'
import { step } from '../support/evidence'

test.use({
  channel: 'chromium',
  permissions: [],
  launchOptions: { args: ['--use-fake-device-for-media-stream'] },
})

// OpenSpec dialog-voice, «Микрофон или голос недоступны» (REQ-VOICE-01, PROTEUS-317).
for (const [surface, origin] of [
  ['web', WEBAPP_URL],
  ['pwa', PWA_URL],
] as const) {
  test(`${surface}: после отказа можно писать и повторить голос в том же диалоге`, async ({
    page,
    context,
  }) => {
    if (test.info().project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
    }
    const session = await context.newCDPSession(page)
    const { targetInfo } = await session.send('Target.getTargetInfo')
    const permission = (setting: 'denied' | 'granted') =>
      session.send('Browser.setPermission', {
        permission: { name: 'microphone' },
        setting,
        origin,
        browserContextId: targetInfo.browserContextId,
      })
    await permission('denied')
    await page.goto(origin)
    await expect
      .poll(() =>
        page.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' })).state),
      )
      .toBe('denied')
    const dismiss = page.getByRole('button', { name: 'Скрыть', exact: true })
    if (await dismiss.isVisible()) await dismiss.click()
    await page.getByTestId('hello-voice').click()
    await page.getByTestId('data-consent-toggle').check()
    await page.getByTestId('consent-continue').click()

    const input = page.getByPlaceholder('Напиши, что происходит')
    const denied = page.getByText(/Микрофон не разрешён/)
    await expect(denied).toBeVisible({ timeout: 30_000 })
    await expect(input).toBeVisible()
    await step(page, `${surface}-denied`, 'После отказа при старте можно писать текстом')
    await expect(denied).toHaveCount(0)
    const dialogUrl = page.url()
    const help = page.getByRole('dialog', { name: 'Разреши доступ к микрофону' })
    const voice = page.getByRole('button', { name: 'Говорить голосом' })
    const retry = help.getByText('Попробовать снова', { exact: true })
    await voice.click()
    await expect(help).toBeVisible()
    await expect(help.getByRole('listitem')).toHaveCount(2)
    await step(page, `${surface}-help`, 'Подсказка объясняет, где разрешить микрофон')

    await retry.click()
    await expect(help).toBeVisible()
    await help.getByText('Продолжить текстом', { exact: true }).click()
    await expect(input).toBeVisible()
    await expect(help).toBeHidden()

    await voice.click()
    await expect(help).toBeVisible()
    await permission('granted')
    await expect
      .poll(() =>
        page.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' })).state),
      )
      .toBe('granted')
    await retry.click()
    await expect(help).toBeHidden()
    await expect(page.getByRole('button', { name: 'Поставить микрофон на паузу' })).toBeVisible()
    await expect(page).toHaveURL(dialogUrl)
    await step(page, `${surface}-recovered`, 'Микрофон снова слушает в том же разговоре')
  })
}
