import { button, openApp, registerAndConfirm, uniqueEmail } from '../support/app'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { step } from '../support/evidence'

/**
 * REQ-VOICE-10 in the mobile client: the sphere takes the colour of the person's mood. The agent mock reports a
 * tone for what is typed (as the real agent's classifier does for what is heard): an angry line turns the sphere
 * red, a frightened one green, a plain one leaves the colour of its state. The sphere is on the voice screen, so each
 * line is typed in the text view and the voice is opened again to look at it.
 */
test('шарик в приложении окрашивается по настроению: злой красный, испуганный зелёный, обычное без цвета', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await clearMailbox()
  await openApp(page)
  await registerAndConfirm(page, uniqueEmail('orb-mood'))
  await button(page, 'Поговорить').click()
  const orb = page.locator('.rd-orb')
  await expect(orb).toBeVisible({ timeout: 30_000 })
  await expect(orb).not.toHaveAttribute('data-mood', /.+/)
  await step(page, 'orb-calm', 'Шарик в спокойном состоянии: без цвета настроения')

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
  await step(page, 'orb-angry', 'Злая реплика: шарик окрасился красным')

  await say('Мне очень страшно, я боюсь')
  await expect(orb).toHaveAttribute('data-mood', 'afraid')
  await step(page, 'orb-afraid', 'Испуганная реплика: шарик позеленел')

  await say('Сегодня обычный день')
  await expect(orb).not.toHaveAttribute('data-mood', /.+/)
  await step(page, 'orb-plain', 'Обычная реплика: цвет настроения ушёл')
})
