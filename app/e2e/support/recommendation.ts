import type { Locator, Page } from '@playwright/test'
import { DialogClientFrame, DialogServerFrame, DialogWsErrorCode } from '@ryadom/contracts/api/dialogs'
import { AGENT_URL } from '../playwright.config'
import { step } from './evidence'
import { expect } from './fixtures'
import { installMicrophone, playedBy, speakIntoMic } from './speech'

const FEEDBACK = 'Этот разговор мне очень помог'
const REPLY = 'Рад, что разговор помог тебе разобраться.'
const RECOMMENDATION_TEXT = 'Рекомендую «Рядом» — сервис, где можно выговориться голосом или в чате.'
const RECOMMENDATION_URL = 'https://слышу-рядом.рф/'

export async function installRecommendationActions(page: Page): Promise<void> {
  await installMicrophone(page.context(), true)
  const mobile = (page.viewportSize()?.width ?? 1280) < 700
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(
    (theme) => {
      localStorage.setItem('ryadom.theme', theme)
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => sessionStorage.setItem('copied-recommendation', text) },
      })
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) =>
          sessionStorage.setItem('shared-recommendation', JSON.stringify(data)),
      })
    },
    mobile ? 'dark' : 'light',
  )
}

export async function omitRecommendationSupport(page: Page): Promise<void> {
  await page.routeWebSocket(
    (url) => url.pathname.endsWith('/dialogs/ws'),
    (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === 'string') {
          const frame = JSON.parse(data)
          if (frame.type === DialogClientFrame.Hello) {
            delete frame.recommendation
            return upstream.send(JSON.stringify(frame))
          }
        }
        return upstream.send(data)
      })
    },
  )
}

export async function rejectFirstTextMessage(page: Page): Promise<void> {
  let rejected = false
  await page.routeWebSocket(
    (url) => url.pathname.endsWith('/dialogs/ws'),
    (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (!rejected && typeof data === 'string') {
          const frame = JSON.parse(data)
          if (frame.type === DialogClientFrame.Message) {
            rejected = true
            return socket.send(
              JSON.stringify({
                v: 1,
                type: DialogServerFrame.Error,
                code: DialogWsErrorCode.RATE_LIMITED,
                message: 'too many messages',
                clientId: frame.clientId,
              }),
            )
          }
        }
        return upstream.send(data)
      })
    },
  )
}

export async function checkRejectedTextMessage(page: Page, input: Locator, send: Locator, slug: string) {
  await input.fill('Эту реплику можно отправить повторно')
  await send.click()
  const rejected = page.getByTestId('dialog-message-rejected')
  await expect(rejected).toContainText('Не отправлено')
  await step(page, `${slug}-rejected`, 'Отклонённая реплика остаётся в чате и помечена «Не отправлено»')
  await rejected.getByRole('button', { name: 'Повторить' }).click()
  await expect(rejected).toHaveCount(0)
  const feed = page.locator('[data-testid="dialog-feed"], .page-current .messages')
  await expect(feed.getByText('Я здесь. Расскажи, что случилось.', { exact: false })).toBeVisible()
  await expect(feed.getByText('Эту реплику можно отправить повторно', { exact: false })).toHaveCount(1)
  await step(page, `${slug}-retried`, 'Повтор отправляет ту же реплику один раз и получает ответ')
}

export async function injectCrisisDuringRecommendation(page: Page): Promise<void> {
  let sent = false
  await page.routeWebSocket(
    (url) => url.pathname.endsWith('/dialogs/ws'),
    (socket) => {
      const upstream = socket.connectToServer()
      upstream.onMessage((data) => {
        socket.send(data)
        if (sent || typeof data !== 'string') return
        const frame = JSON.parse(data)
        if (frame.type === DialogServerFrame.Recommendation && frame.speechPending) {
          sent = true
          socket.send(
            JSON.stringify({
              v: 1,
              type: DialogServerFrame.Safety,
              level: 'crisis',
              step: 'call',
              pinned: true,
              text: null,
              hotlines: [],
            }),
          )
        }
      })
    },
  )
}

export function textTurn(input: Locator, send: Locator, replies: Locator): (text: string) => Promise<void> {
  return async (text) => {
    const count = await replies.count()
    await input.fill(text)
    await send.click()
    await expect(replies.nth(count)).toBeVisible({ timeout: 20_000 })
  }
}

async function reachThreshold(send: (text: string) => Promise<void>) {
  for (let i = 0; i < 3; i++) await send(`Заметка о моём дне номер ${i + 1}`)
  await setNextRecommendation(FEEDBACK)
  await send(FEEDBACK)
}

export async function checkLegacyRecommendation(
  page: Page,
  send: (text: string) => Promise<void>,
  slug: string,
) {
  await reachThreshold(send)
  await setNextRecommendation(FEEDBACK)
  await send(FEEDBACK)
  await expect(page.getByTestId('dialog-recommendation')).toHaveCount(0)
  await step(page, `${slug}-legacy`, 'Клиент без поддержки видит обычный ответ после явного отзыва')
}

// openspec/changes/add-dialog-recommendation, «Карточка рекомендации сервиса в разговоре».
export async function checkTextRecommendation(
  page: Page,
  send: (text: string) => Promise<void>,
  slug: string,
) {
  const card = page.getByTestId('dialog-recommendation')
  const fear = page.getByRole('heading', { name: 'Если сейчас тяжело', exact: true })
  const closeHelp = page.getByText('Закрыть', { exact: true }).last()
  await expect(card).toHaveCount(0)
  await step(page, `${slug}-start`, 'В начале разговора карточки нет')
  await reachThreshold(send)
  await expect(card).toHaveCount(0)
  await step(page, `${slug}-threshold`, 'На восьми сообщениях карточка ещё не появляется')

  await send('Спасибо за диалог')
  await expect(card).toHaveCount(0)
  await step(page, `${slug}-ambiguous`, 'Вежливое «Спасибо за диалог» после порога не открывает карточку')
  const feedback = slug === 'web' ? 'Спасибо тебе за помощь' : 'спасибо за поомщь'
  await setNextRecommendation(feedback)
  await send(feedback)
  await expect(card).toBeVisible()
  await expect(card).toBeInViewport()
  await expect(
    card
      .locator('xpath=../preceding-sibling::*[1] | preceding-sibling::*[1]')
      .filter({ hasText: REPLY })
      .first(),
  ).toBeAttached()
  await step(page, `${slug}-text`, 'После явного отзыва карточка видна под ответом')

  await card.getByRole('button', { name: 'Скопировать текст' }).click()
  await expect(card.getByRole('status')).toHaveText('Текст скопирован')
  expect(await page.evaluate(() => sessionStorage.getItem('copied-recommendation'))).toBe(
    `${RECOMMENDATION_TEXT} ${RECOMMENDATION_URL}`,
  )
  await card.getByRole('button', { name: 'Поделиться рекомендацией' }).click()
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('shared-recommendation') ?? 'null')),
  ).toEqual({
    text: RECOMMENDATION_TEXT,
    url: RECOMMENDATION_URL,
  })
  await step(page, `${slug}-copy`, 'Готовый текст со ссылкой скопирован')

  await page
    .getByRole('button', { name: /\bSOS$/ })
    .filter({ visible: true })
    .first()
    .click()
  await expect(fear).toBeVisible()
  await expect(card).toHaveCount(0)
  await step(page, `${slug}-manual-sos`, 'Штатная кнопка SOS открывает помощь и скрывает карточку')
  await closeHelp.click()
  await expect(card).toBeInViewport()
  await step(page, `${slug}-manual-sos-return`, 'После ручного SOS карточка снова доступна')

  await send('не хочу жить')
  await expect(page.locator('[data-testid="sos-call-now"]')).toBeVisible()
  await expect(card).toHaveCount(0)
  await step(page, `${slug}-crisis`, 'Кризисная помощь появляется вместо рекомендации')
  await closeHelp.click()
  await send(FEEDBACK)
  await expect(card).toHaveCount(0)
  await step(
    page,
    `${slug}-crisis-return`,
    'После кризиса закрытие листа и новая благодарность не возвращают карточку',
  )
}

async function setNextTranscript(text: string | null): Promise<void> {
  const response = await fetch(`${AGENT_URL}/dev/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  expect(response.ok).toBe(true)
}

async function setNextRecommendation(text: string | null): Promise<void> {
  const response = await fetch(`${AGENT_URL}/dev/recommendation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  expect(response.ok).toBe(true)
}

export async function checkVoiceRecommendation(
  page: Page,
  send: (text: string) => Promise<void>,
  slug: string,
  crisis = false,
) {
  await reachThreshold(send)
  const card = page.getByTestId('dialog-recommendation')
  const voiceToggle = page.getByRole('button', { name: 'Говорить голосом', exact: true })
  const mic = page.getByRole('button', { name: 'Говорить', exact: true })
  const stop = page.getByRole('button', { name: 'Остановить запись', exact: true })
  const caption = page.getByTestId('voice-caption')

  async function speak() {
    const feedback = 'Мне очень помог разговор с тобой'
    await setNextRecommendation(feedback)
    await setNextTranscript(feedback)
    await expect(stop).toBeVisible()
    // Send a steady signal so the mock does not depend on where Chromium's periodic beep lands.
    await speakIntoMic(page, true)
    await page.waitForTimeout(650)
    await stop.click()
    await speakIntoMic(page, false)
    await expect(caption).toHaveText(REPLY, { timeout: 20_000 })
  }

  try {
    await voiceToggle.click()
    await expect(stop).toBeVisible()
    await expect(card).toHaveCount(0)
    await step(page, `${slug}-voice-recording`, 'Во время записи карточки нет')
    const before = await playedBy(page)
    await speak()
    if (crisis) {
      await expect(page.getByTestId('sos-call-now')).toBeVisible()
      await expect(card).toHaveCount(0)
      await step(
        page,
        `${slug}-voice-crisis`,
        'Кризисная помощь открылась, пока карточка ждала конца озвучки',
      )
      await page.getByText('Закрыть', { exact: true }).last().click()
      await expect(page.getByText('Нажми на шар и говори', { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(card).toHaveCount(0)
      await step(
        page,
        `${slug}-voice-crisis-return`,
        'Даже после озвучки и закрытия листа карточка не появилась',
      )
      return
    }
    await expect.poll(() => playedBy(page)).toBeGreaterThan(before)
    await expect(card).toHaveCount(0)
    await step(page, `${slug}-voice-speaking`, 'Ответ уже на экране, карточка ждёт окончания озвучки')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(mic).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    )
    const cardBounds = (await card.boundingBox())!
    const micBounds = (await mic.boundingBox())!
    expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(micBounds.y)
    await step(
      page,
      `${slug}-voice-done`,
      'После озвучки карточка видна под шаром, управление микрофоном доступно',
    )
    await card.getByRole('button', { name: 'Закрыть рекомендацию' }).click()
    await mic.click()
    await speak()
    await expect(page.getByText('Нажми на шар и говори', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(card).toHaveCount(0)
    await step(
      page,
      `${slug}-voice-dismissed`,
      'После закрытия карточка не возвращается при новой благодарности',
    )
  } finally {
    await setNextTranscript(null)
    await setNextRecommendation(null)
  }
}
