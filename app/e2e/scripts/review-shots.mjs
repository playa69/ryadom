#!/usr/bin/env node
/**
 * Captures every screen at several widths into `review/` for a human (or Claude) to look at.
 *
 * Not part of the test suite: the e2e specs assert behaviour, this only takes pictures, so
 * layout work does not have to go through a full test run to be seen.
 *
 * Usage: node e2e/scripts/review-shots.mjs   (needs the stack from scripts/stack.mjs running)
 */
import { chromium } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(repoRoot, 'review')

const WEB = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:3100'
const APP = process.env.E2E_APP_URL ?? 'http://127.0.0.1:3102'
const MAIL = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:8027'

const WIDTHS = [
  { name: '360', width: 360, height: 780 },
  { name: '414', width: 414, height: 896 },
  { name: '820', width: 820, height: 1180 }, // tablet (iPad Air portrait)
  { name: '1280', width: 1280, height: 900 },
  { name: '1920', width: 1920, height: 1080 }, // nothing checked wider than 1280 before this
]

const WEB_PAGES = [
  ['landing', '/'],
  ['download', '/download'],
  ['delete-account', '/delete-account'],
  ['privacy', '/privacy'],
  ['terms', '/terms'],
]

async function waitForCode(email) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/messages?limit=50`)).json()
    const mine = (list.messages ?? []).find((m) => m.To.some((t) => t.Address.toLowerCase() === email))
    if (mine) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${mine.ID}`)).json()
      const match = `${full.Text ?? ''}\n${full.HTML ?? ''}`.match(/\b(\d{6})\b/)
      if (match) return match[1]
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`no confirmation code arrived for ${email}`)
}

/** Horizontal overflow is invisible in a screenshot but obvious as a number. */
async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const over = doc.scrollWidth - doc.clientWidth
    if (over <= 1) return null
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)
    return { over, wide }
  })
}

/**
 * Text that nearly touches a screen edge reads as broken even when nothing technically overflows,
 * and a screenshot at 1:1 is a poor instrument for judging eight pixels. Measure it instead.
 */
async function gutters(page, min) {
  return page.evaluate((minGap) => {
    const width = document.documentElement.clientWidth
    const offenders = []
    for (const el of document.querySelectorAll('h1,h2,h3,p,li,td,th,span,a,button,label,summary')) {
      if (!el.textContent.trim()) continue
      // Framework7 keeps earlier screens in the DOM, parked off to the side. They are not on
      // screen, so their boxes say nothing about the layout a person sees.
      const page = el.closest('.page')
      if (page && !page.classList.contains('page-current')) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue
      if (Number(style.opacity) === 0) continue
      // Layout wrappers are allowed to span the full width; only boxes that actually paint at
      // their edge, and leaf elements that hold text, say anything about the visible margin.
      const paints =
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(style.borderTopWidth) > 0
      if (!paints && el.children.length > 0) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const gap = Math.min(r.left, width - r.right)
      if (gap < minGap) {
        offenders.push({
          gap: Math.round(gap),
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().split(' ').filter(Boolean)[0] || '',
          text: el.textContent.trim().slice(0, 40),
        })
      }
    }
    return offenders.sort((a, b) => a.gap - b.gap).slice(0, 6)
  }, min)
}

const problems = []

/**
 * One account for the whole run. Requesting a code is rate limited per address and per IP, so
 * registering once per viewport walks straight into the app's own protection against guessing.
 */
const account = { email: `review-${process.pid}@example.com`, password: 'review-Password-1' }
let registered = false

async function shoot(page, name, options = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Framework7 slides pages; measuring mid-transition reports boxes nobody ever sees at rest.
  await page
    .waitForFunction(() => !document.querySelector('.page-transitioning, .router-transition'), null, {
      timeout: 5000,
    })
    .catch(() => {})
  await page.waitForTimeout(500)
  const over = await overflow(page)
  if (over) problems.push(`${name}: horizontal overflow ${over.over}px - ${over.wide.join(', ')}`)
  // 12px is below any gutter this design uses, so anything under it is a mistake, not a choice.
  const tight = await gutters(page, options.minGutter ?? 12)
  for (const t of tight) {
    problems.push(`${name}: ${t.gap}px from the edge - ${t.tag}.${t.cls} "${t.text}"`)
  }
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: options.fullPage ?? false })
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()

for (const size of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    permissions: ['microphone'],
  })
  const page = await context.newPage()

  for (const [name, path] of WEB_PAGES) {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' })
    await shoot(page, `web-${name}-${size.name}`, { fullPage: true })
  }

  // ── the app, with a real session ────────────────────────────────────────────
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-current', { timeout: 30_000 })
  await shoot(page, `app-login-${size.name}`)

  if (!registered) {
    await page.locator('.page-current').getByText('Создать аккаунт').click()
    await page.locator('.page-current input[name="name"]').fill('Обзор')
    await page.locator('.page-current input[name="email"]').fill(account.email)
    await page.locator('.page-current input[name="password"]').fill(account.password)
    await page.locator('.page-current .rd-consents .icon-checkbox').click()
    await page.locator('.page-current').getByText('Создать аккаунт').click()
    await page.waitForSelector('text=Подтверди почту', { timeout: 30_000 })
    await shoot(page, `app-confirm-email-${size.name}`)
    await page.getByRole('textbox', { name: 'Код из письма' }).fill(await waitForCode(account.email))
    registered = true
  } else {
    await page.locator('.page-current input[name="email"]').fill(account.email)
    await page.locator('.page-current input[name="password"]').fill(account.password)
    // By class, not by text: "Войти" also appears inside "Не получается войти?".
    await page.locator('.page-current a.button-fill').first().click()
  }
  await page.waitForSelector('#rd-tabbar', { timeout: 30_000 })
  const dismiss = page.getByRole('button', { name: 'Скрыть' })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  await shoot(page, `app-home-${size.name}`)

  await page.getByRole('button', { name: 'SOS' }).first().click()
  await page.waitForSelector('text=Если сейчас тяжело')
  await shoot(page, `app-sos-${size.name}`)
  await page.locator('.sheet-modal.modal-in').getByText('Закрыть').click()
  await page.waitForTimeout(400)

  // This script exists to produce pictures, so one stubborn screen must not cost the whole run.
  try {
    await page.locator('.page-current').getByText('Поговорить').click()
    const composer = page.locator('.page-current .rd-dialog-bar textarea')
    await composer.waitFor({ timeout: 30_000 })
    // The screen can re-render between resolving the box and typing into it, which leaves React
    // with an empty draft and the send button disabled. Retry until the button agrees.
    for (let attempt = 0; attempt < 10; attempt++) {
      await composer.fill('Сегодня было очень тяжело')
      const ready = await page
        .waitForFunction(
          () => {
            const b = document.querySelector('.page-current .rd-icon-button--primary')
            return b && !b.disabled
          },
          null,
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false)
      if (ready) break
    }
    await page.locator('.page-current .rd-icon-button--primary').click({ timeout: 30_000 })
    await page.waitForFunction(() => document.querySelectorAll('.message-received').length >= 2, null, {
      timeout: 30_000,
    })
    await shoot(page, `app-dialog-${size.name}`)

    await page.getByRole('button', { name: 'Завершить разговор' }).click()
    await page.waitForSelector('text=Что забираешь с собой?')
    await shoot(page, `app-dialog-end-${size.name}`)
    await page.locator('.sheet-modal.modal-in').getByText('Продолжить разговор').click()
    await page.waitForTimeout(400)
  } catch (error) {
    const state = await page.evaluate(() => {
      const current = document.querySelector('.page-current')
      const sendButton = current && current.querySelector('.rd-icon-button--primary')
      const box = current && current.querySelector('.rd-dialog-bar textarea')
      return {
        page: current && current.dataset.name,
        status: current && current.querySelector('.rd-dialog-status')?.textContent?.trim(),
        draft: box && box.value,
        sendDisabled: sendButton ? sendButton.disabled : null,
      }
    })
    problems.push(`app-dialog-${size.name}: could not drive the conversation - ${JSON.stringify(state)}`)
    await shoot(page, `app-dialog-${size.name}`)
  }

  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#rd-tabbar', { timeout: 30_000 })

  await page.locator('#rd-tabbar').getByText('Журнал', { exact: true }).click()
  await page.waitForTimeout(800)
  await shoot(page, `app-journal-${size.name}`)

  await page.locator('#rd-tabbar').getByText('Профиль', { exact: true }).click()
  await page.waitForTimeout(600)
  await shoot(page, `app-profile-${size.name}`, { fullPage: false })

  // Opened, not confirmed: the account is shared by every viewport in this run.
  await page.getByText('Стереть всё и удалить аккаунт').click()
  await page.waitForSelector('text=Это действие необратимо')
  await shoot(page, `app-delete-${size.name}`)

  await context.close()
}

await browser.close()

if (problems.length) {
  console.log('\nOVERFLOW PROBLEMS')
  for (const p of problems) console.log(' -', p)
} else {
  console.log('\nno horizontal overflow at any width')
}
console.log(`\nshots in ${OUT}`)
