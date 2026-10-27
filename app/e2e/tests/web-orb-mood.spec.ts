import { openWebApp, registerAndConfirm, talkButton, uniqueEmail } from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

/**
 * REQ-VOICE-10: the sphere takes the colour of the person's mood. The agent mock reports a tone for what is typed
 * (as the real agent's classifier does for what is heard): an angry line turns the sphere red, a frightened one
 * green, a plain one leaves the colour of its state. The sphere is on the voice screen, so each line is typed in
 * the text view and the voice is opened again to look at it.
 */
test('шарик в вебе окрашивается по настроению: злой красный, испуганный зелёный, обычное без цвета', async ({
  page,
  shot,
}) => {
  test.setTimeout(150_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-orb-mood'))
  await talkButton(page).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
  const orb = page.locator('[data-slot="voice-orb"]')
  await expect(orb).toBeVisible({ timeout: 30_000 })
  await expect(orb).not.toHaveAttribute('data-mood', /.+/)

  const say = async (text: string) => {
    await page.getByRole('button', { name: 'Писать текстом' }).click()
    const input = page.getByPlaceholder('Напиши, что происходит')
    await expect(input).toBeVisible({ timeout: 30_000 })
    await input.fill(text)
    await page.getByRole('button', { name: 'Отправить' }).click()
    await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
    await page.getByRole('button', { name: 'Говорить голосом' }).click()
    await expect(orb).toBeVisible({ timeout: 30_000 })
  }

  await say('Меня всё бесит, достало это всё')
  await expect(orb).toHaveAttribute('data-mood', 'angry')
  await shot(page, 'web-orb-mood-angry')

  await say('Мне очень страшно, я боюсь')
  await expect(orb).toHaveAttribute('data-mood', 'afraid')
  await shot(page, 'web-orb-mood-afraid')

  await say('Сегодня обычный день')
  await expect(orb).not.toHaveAttribute('data-mood', /.+/)
})
