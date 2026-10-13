import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import {
  button,
  dialogInput,
  expectNoHorizontalOverflow,
  goTo,
  homeInput,
  messages,
  modal,
  modalButton,
  openProfile,
  openWebApp,
  startAnonymously,
} from '../support/web'
import { expect, test } from '../support/fixtures'

/**
 * Memory in the web app: turning it on through its own consent sheet, a conversation in which the
 * person asks "запомни, что …", the card "Я запомнил" on home afterwards, the screen "Память" with
 * that fact (hidden texts, pin, "Забыть" with "Вернуть", the download), and a conversation "Без
 * памяти". The agent is the mock: its "extraction" turns the person's own "запомни, что …" into a
 * fact when the conversation ends, a moment later, the way a real extraction takes a while.
 */

const REMEMBER = 'Запомни, что мне помогают вечерние прогулки'
const FACT = 'Мне помогают вечерние прогулки'

/** Starts a conversation from home with the typed words, waits for the reply, ends it and returns home. */
async function talkAndEnd(page: Page, words: string): Promise<void> {
  await homeInput(page).fill(words)
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialogInput(page)).toBeVisible()

  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
}

async function openMemory(page: Page): Promise<void> {
  await openProfile(page)
  await page.getByTestId('row-memory').click()
  await expect(page).toHaveURL(/\/profile\/memory$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Память', exact: true })).toBeVisible()
}

test('память в вебе: включить → разговор → карточка → экран «Память» → забыть', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await openWebApp(page)
  await startAnonymously(page)

  // ── off by default: no "Без памяти" on home, nothing remembered ─────────────────────────────
  await expect(page.getByTestId('incognito')).toHaveCount(0)
  await openMemory(page)
  await expect(page.getByTestId('memory-empty')).toContainText('Если включить память')
  const remember = page.getByTestId('memory-switch').getByRole('checkbox')
  await expect(remember).not.toBeChecked()

  // ── the consent sheet: a document of its own, and "Не сейчас" leaves memory off ─────────────
  await remember.click()
  await expect(modal(page).getByRole('heading', { name: 'Память' })).toBeVisible()
  await expect(modal(page)).toContainText('Память можно не включать')
  await expect(modal(page)).toContainText('хранится в России')
  await shot(page, 'web-memory-consent')
  await modalButton(page, 'Не сейчас').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(remember).not.toBeChecked()

  await remember.click()
  await modalButton(page, 'Включить память').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(remember).toBeChecked()
  await expect(page.getByTestId('memory-empty')).toContainText('Пока я ничего не запомнил')
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-memory-empty')

  // ── a conversation with memory, and the card after it ───────────────────────────────────────
  await goTo(page, 'Новый разговор')
  await expect(page.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'false')
  await talkAndEnd(page, REMEMBER)

  const card = page.getByTestId('memory-card')
  // The mock finishes its "extraction" a moment after the end; the card polls every 3 s for up to 30.
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByRole('heading', { name: 'Я запомнил' })).toBeVisible()
  await expect(card.getByTestId('memory-card-item')).toHaveCount(1)
  await expect(card.getByTestId('memory-card-item')).toContainText(FACT)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-memory-card')

  // ── the screen: texts hidden in a browser until "Показать", then the fact with its source ────
  await card.getByTestId('memory-card-link').click()
  await expect(page).toHaveURL(/\/profile\/memory$/)
  const fact = page.getByTestId('memory-fact')
  await expect(fact).toHaveCount(1)
  await expect(fact.getByTestId('memory-fact-text')).toHaveText('Текст скрыт')
  await page.getByTestId('memory-reveal').click()
  await expect(fact.getByTestId('memory-fact-text')).toHaveText(FACT)
  await expect(fact).toContainText(/из разговора \d+/)
  await expect(
    page.locator('[data-group="helps"]').getByRole('heading', { name: 'Что помогает' }),
  ).toBeVisible()

  // Pinned: the agent will not change it.
  await fact.getByTestId('memory-pin').click()
  await expect(fact).toContainText('Закреплено')
  await expect(fact.getByTestId('memory-unpin')).toBeVisible()
  await shot(page, 'web-memory-screen', { fullPage: true })

  // The download: a JSON file with what is remembered.
  const downloading = page.waitForEvent('download')
  await page.getByTestId('memory-export').click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^ryadom-memory-\d{4}-\d{2}-\d{2}\.json$/)
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    facts: { text: string }[]
  }
  expect(exported.facts.map((item) => item.text)).toEqual([FACT])

  // "Забыть" can be taken back for five seconds…
  await fact.getByTestId('memory-delete').click()
  await expect(page.getByTestId('memory-undo')).toBeVisible()
  await shot(page, 'web-memory-undo')
  await page.getByTestId('memory-undo-button').click()
  await expect(fact.getByTestId('memory-fact-text')).toHaveText(FACT)

  // …and after them it is gone for good, also after a reload.
  await fact.getByTestId('memory-delete').click()
  await expect(page.getByTestId('memory-undo')).toBeVisible()
  await expect(page.getByTestId('memory-undo')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('memory-empty')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('memory-empty')).toContainText('Пока я ничего не запомнил', {
    timeout: 20_000,
  })

  // ── a conversation "Без памяти": marked on its screen, and no card after it ─────────────────
  await goTo(page, 'Новый разговор')
  await page.getByTestId('incognito-toggle').click()
  await expect(page.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('incognito')).toContainText('удалится через сутки')
  await homeInput(page).fill('Запомни, что я люблю джаз')
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(page.getByTestId('dialog-incognito')).toContainText('Без памяти')
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await shot(page, 'web-memory-incognito-dialog')
  await page.getByTestId('dialog-end').click()
  await modalButton(page, 'Завершить').click()
  await page.getByTestId('alert-ok').click()
  await expect(page).toHaveURL(/\/home$/)
  // The mock is done in about a second and a half; well past it, still no card.
  await page.waitForTimeout(5_000)
  await expect(page.getByTestId('memory-card')).toHaveCount(0)
  // The journal keeps it for now, marked: it goes a day after its last message.
  await goTo(page, 'Все разговоры')
  await expect(page.getByTestId('journal-incognito')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId('journal-incognito')).toContainText('Без памяти')
  await shot(page, 'web-memory-journal')
  await openMemory(page)
  await expect(page.getByTestId('memory-empty')).toBeVisible()

  // ── turning it off keeps nothing on the home screen ─────────────────────────────────────────
  await page.getByTestId('memory-switch').getByRole('checkbox').click()
  await expect(page.getByTestId('memory-switch').getByRole('checkbox')).not.toBeChecked()
  await goTo(page, 'Новый разговор')
  await expect(page.getByTestId('incognito')).toHaveCount(0)
  await expect(button(page, 'Поговорить')).toBeVisible()
})

/** Switches memory on the agent mock: `off` is the feature off on the server. Dev control of the mock. */
async function setMemoryMode(mode: 'on' | 'off'): Promise<void> {
  const base = process.env.E2E_AGENT_URL ?? 'http://127.0.0.1:8081'
  const response = await fetch(`${base}/dev/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  if (!response.ok) throw new Error(`agent mock refused the memory mode: ${response.status}`)
}

test('функция выключена на сервере: раздела «Память» нет, по ссылке — «пока недоступна»', async ({
  page,
}) => {
  await setMemoryMode('off')
  try {
    await openWebApp(page)
    await startAnonymously(page)
    await expect(page.getByTestId('incognito')).toHaveCount(0)

    await openProfile(page)
    // The rest of the profile is there; the section is not, not even as "unavailable".
    await expect(page.getByTestId('voice-section')).toBeVisible()
    await expect(page.getByTestId('memory-section')).toHaveCount(0)

    await openWebApp(page, '/profile/memory')
    await expect(page.getByTestId('memory-not-yet')).toContainText('Память пока недоступна', {
      timeout: 20_000,
    })
    await expect(page.getByTestId('memory-switch')).toHaveCount(0)
    await expect(page.getByTestId('memory-forget-all')).toHaveCount(0)
  } finally {
    await setMemoryMode('on')
  }
})
