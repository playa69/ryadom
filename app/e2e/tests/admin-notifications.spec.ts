import { randomBytes } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  PUSH_PROJECT,
  PUSH_SERVICE_TOKEN,
  adminUrl,
  clearPushes,
  pushesTo,
  signInToAdmin,
  subscribeDevice,
} from '../support/admin'
import { expect, test } from '../support/fixtures'
import { deviceLogin, guestDevice } from '../support/session'

/**
 * `openspec/changes/add-push-notifications`: «Уведомление человеку из карточки» and «Журнал действий» (admin-console),
 * «Доставка через RuStore Push» and «Уведомления только открытым сессиям» (push-notifications). The phones are the
 * RuStore Push stub (dev/push-mock): a device subscribes the way the Android app does, through the API, and what the
 * server sent is read back from the stub. The app's own switch and the shade of a real phone are checked by hand.
 */

// The admin console is laid out for a desk only (admin-console, «Каркас админки»): a phone viewport proves nothing here.
test.skip(({ isMobile }) => isMobile, 'админка рассчитана на экран рабочего места')

/** A guest with a phone of its own: the account and, unless told otherwise, a subscribed push token. */
async function personWithPhone(request: APIRequestContext, tokenPrefix: string | null) {
  const session = await deviceLogin(request, await guestDevice(request))
  const token = tokenPrefix === null ? null : `${tokenPrefix}${randomBytes(12).toString('hex')}`
  if (token) await subscribeDevice(request, session.tokens.accessToken, token)
  return { userId: session.user.id, token }
}

const card = (page: Page) => page.getByTestId('user-notifications')

async function send(page: Page, title: string, body: string): Promise<void> {
  await card(page).getByLabel('Заголовок').fill(title)
  await card(page).getByLabel('Текст', { exact: true }).fill(body)
  await card(page).getByRole('button', { name: 'Отправить' }).click()
}

test('админка: уведомление человеку из карточки, итог отправки, журнал, устаревший токен и завершённые сессии', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(180_000)
  await clearPushes()
  const withPhone = await personWithPhone(request, 'phone-')
  const withoutPhone = await personWithPhone(request, null)
  const withOldPhone = await personWithPhone(request, 'gone-')
  const signedOut = await personWithPhone(request, 'phone-')

  await signInToAdmin(page)

  // ── «Отправка на телефон» and «Пустой текст» ─────────────────────────────
  await page.goto(adminUrl(`/users/${withPhone.userId}`))
  await expect(card(page).getByTestId('push-device')).toHaveText(/RuStore · ru\.ryadom\.companion/)
  await shot(page, 'notifications-card')

  await send(page, 'Обновление', '   ')
  await expect(card(page).getByText('Напишите текст.')).toBeVisible()
  await shot(page, 'notifications-empty-text')
  expect(await pushesTo(withPhone.token!)).toEqual([])

  await send(page, 'Обновление', 'Завтра с 10:00 до 10:15 разговоры недоступны')
  await expect(card(page).getByText('Отправлено на 1 из 1 устройства.')).toBeVisible()
  await shot(page, 'notifications-sent')
  // After a success the form is empty again, ready for the next one.
  await expect(card(page).getByLabel('Заголовок')).toHaveValue('')

  const [delivered] = await pushesTo(withPhone.token!)
  expect(delivered).toMatchObject({
    projectId: PUSH_PROJECT,
    authorization: `Bearer ${PUSH_SERVICE_TOKEN}`,
    status: 200,
    message: {
      token: withPhone.token,
      notification: { title: 'Обновление', body: 'Завтра с 10:00 до 10:15 разговоры недоступны' },
    },
  })

  // ── «Уведомление в журнале» ──────────────────────────────────────────────
  await page.goto(adminUrl(`/audit?user=${withPhone.userId}`))
  const entry = page.getByRole('row').filter({ hasText: 'Уведомление отправлено' })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('заголовок: Обновление')
  await expect(entry).toContainText('текст: Завтра с 10:00 до 10:15 разговоры недоступны')
  await expect(entry).toContainText('отправлено: 1 из 1')
  await shot(page, 'notifications-audit')

  // ── «Нет устройств» ──────────────────────────────────────────────────────
  await page.goto(adminUrl(`/users/${withoutPhone.userId}`))
  await expect(card(page).getByTestId('push-devices-none')).toHaveText(
    'Нет устройств с включёнными уведомлениями.',
  )
  await send(page, 'Проверка', 'Есть кто?')
  await expect(
    card(page).getByText('Не отправлено ни на одно устройство: нет устройств с включёнными уведомлениями.'),
  ).toBeVisible()
  // What was typed is kept after a failure.
  await expect(card(page).getByLabel('Текст', { exact: true })).toHaveValue('Есть кто?')

  // ── «Токен устарел» ──────────────────────────────────────────────────────
  await page.goto(adminUrl(`/users/${withOldPhone.userId}`))
  await expect(card(page).getByTestId('push-device')).toHaveCount(1)
  await send(page, 'Проверка', 'Дошло?')
  await expect(
    card(page).getByText('Не отправлено ни на одно устройство: push-сервис не принял.'),
  ).toBeVisible()
  await expect(card(page).getByTestId('push-devices-none')).toBeVisible()
  expect((await pushesTo(withOldPhone.token!)).map((push) => push.status)).toEqual([404])

  // ── «Сессии завершены администратором» ───────────────────────────────────
  await page.goto(adminUrl(`/users/${signedOut.userId}`))
  await expect(card(page).getByTestId('push-device')).toHaveCount(1)
  await page.getByRole('button', { name: 'Завершить все сессии' }).click()
  await expect(page.getByText('Все сессии завершены. Войти заново можно сразу.')).toBeVisible()
  await expect(card(page).getByTestId('push-devices-none')).toBeVisible()
  await send(page, 'Проверка', 'Дошло?')
  await expect(
    card(page).getByText('Не отправлено ни на одно устройство: нет устройств с включёнными уведомлениями.'),
  ).toBeVisible()
  expect(await pushesTo(signedOut.token!)).toEqual([])
})
