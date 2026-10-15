import type { Page } from '@playwright/test'
import { button as appButton, openApp, startAnonymously as startApp } from '../support/app'
import { expect, test } from '../support/fixtures'
import { openWebApp, startAnonymously as startWeb, talkButton } from '../support/web'

/**
 * The microphone and speaker menu of the voice screen, in both clients. Chrome's fake devices give a
 * computer with several microphones and speakers: the chip under the voice buttons names the one that
 * listens, the menu lists them with "Как в системе" first, a choice moves the conversation to another
 * microphone without restarting it, and the next conversation starts on the chosen one.
 */

/** Whatever the person picks next: a device other than the checked one and other than "as in the system". */
async function pickAnother(items: ReturnType<Page['locator']>, checked: string): Promise<string> {
  const labels = (await items.allInnerTexts()).map((text) => text.trim())
  const next = labels.find((label) => label !== checked && !label.startsWith('Как в системе'))
  expect(next, 'есть другой микрофон, кроме отмеченного').toBeTruthy()
  return next!
}

test('веб: плашка называет микрофон, меню меняет его посреди разговора и запоминает', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await openWebApp(page)
  await startWeb(page)
  await talkButton(page).click()
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/)

  // Tap-to-talk (the suite's mode): after the greeting the microphone opens for the first turn.
  const chip = page.getByTestId('voice-devices')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dialog-mic')).toHaveAccessibleName('Остановить запись', { timeout: 30_000 })
  const listening = (await chip.innerText()).trim()
  expect(listening.length).toBeGreaterThan(0)

  await chip.click()
  const menu = page.getByTestId('voice-devices-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByText('Микрофон', { exact: true })).toBeVisible()
  const inputs = menu.getByRole('group').first().getByRole('menuitemradio')
  await expect(inputs.first()).toContainText('Как в системе')
  await expect(menu.getByRole('menuitemradio', { checked: true }).first()).toContainText(listening)

  const next = await pickAnother(inputs, listening)
  await inputs.filter({ hasText: next }).first().click()
  // The menu stays open, so the meter can show the new microphone at work.
  await expect(menu).toBeVisible()
  await expect(inputs.filter({ hasText: next }).first()).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(chip).toHaveText(next)
  // The turn goes on: nothing restarted the recording.
  await expect(page.getByTestId('dialog-mic')).toHaveAccessibleName('Остановить запись')

  // Kept in this browser: the next conversation starts on it.
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ryadom.web.audio-devices') ?? 'null'),
  )
  expect(stored?.input?.label).toBe(next)
  await page.reload()
  await expect(page.getByTestId('voice-devices')).toHaveText(next, { timeout: 30_000 })
  expect(failures).toEqual([])
})

test('PWA: плашка и лист «Микрофон и звук» меняют микрофон посреди разговора', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await openApp(page)
  await startApp(page)
  await appButton(page, 'Поговорить').click()

  const chip = page.locator('.page-current [data-testid="voice-devices"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  const listening = (await chip.innerText()).replace(/mic|chevron_down/g, '').trim()

  await chip.click()
  const sheet = page.locator('.sheet-modal.modal-in')
  await expect(sheet.getByText('Микрофон и звук')).toBeVisible()
  const inputs = sheet.locator('.rd-devices-list').first().locator('.item-title')
  await expect(inputs.first()).toContainText('Как в системе')
  const next = await pickAnother(inputs, listening)
  await inputs.filter({ hasText: new RegExp(`^${next.replace(/[()]/g, '\\$&')}$`) }).click()
  await sheet
    .getByRole('button', { name: 'Готово' })
    .or(sheet.getByRole('link', { name: 'Готово' }))
    .first()
    .click()
  await expect(chip).toContainText(next)
  expect(failures).toEqual([])
})
