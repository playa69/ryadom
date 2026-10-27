#!/usr/bin/env node
/**
 * A demo account with a lived-in journal, for screenshots and for showing the product: signs in as
 * «Женя» (registers on the first run, the code is read from Mailpit) and fills the agent mock with
 * a handful of conversations spread over the last weeks, so the sidebar shows every group
 * (today, yesterday, last 7 days, earlier) and a past conversation reads like a real one.
 * Then it saves the browser session where ui-shots.mjs looks for it, so the next shots use it.
 *
 * Needs the dev stack of this worktree (`pnpm stand:up`): the web app, the API, Mailpit and the agent mock (the
 * seed endpoint lives in dev/agent-mock). The addresses are the stand's (app/.stand.json; the old fixed ports
 * without a slot); `--stack e2e` uses the e2e stack instead. Run again any time: the seed replaces the mock's
 * dialogs for the user.
 *
 * Usage: node e2e/scripts/demo-account.mjs [--base <web app url>] [--mail <Mailpit url>]
 *                                           [--agent <mock url>] [--state <file>] [--stack e2e]
 */
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCOUNT, seedJournal } from './demo-data.mjs'
import { standUrls } from './shots/stand.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const urls = standUrls({ stack: arg('stack', 'dev') })
const BASE = arg('base', urls.web).replace(/\/$/, '')
const MAIL = arg('mail', urls.mail).replace(/\/$/, '')
const AGENT = arg('agent', urls.mock).replace(/\/$/, '')
const STATE = resolve(arg('state', join(repoRoot, '.playwright-mcp', 'web-state.json')))

// ── mail ─────────────────────────────────────────────────────────────────────────────────────
async function newestCode(email, notId) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/messages?limit=50`)).json()
    const mine = (list.messages ?? []).find((m) => m.To.some((t) => t.Address.toLowerCase() === email) && m.ID !== notId)
    if (mine) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${mine.ID}`)).json()
      const code = `${full.Text ?? ''}\n${full.HTML ?? ''}`.match(/\b(\d{6})\b/)?.[1]
      if (code) return code
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no code for ${email}`)
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' })
const page = await context.newPage()

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.locator('input[name="email"]').fill(ACCOUNT.email)
await page.locator('input[name="password"]').fill(ACCOUNT.password)
await page.locator('form button[type="submit"]').first().click()

const signedIn = await page.waitForURL('**/home', { timeout: 8000 }).then(() => true, () => false)
if (!signedIn) {
  console.log('no such account yet: registering')
  const before = (await (await fetch(`${MAIL}/api/v1/messages?limit=1`)).json()).messages?.[0]?.ID
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' })
  await page.locator('input[name="name"]').fill(ACCOUNT.name)
  await page.locator('input[name="email"]').fill(ACCOUNT.email)
  await page.locator('input[name="password"]').fill(ACCOUNT.password)
  await page.getByTestId('consents').getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click()
  await page.getByRole('heading', { name: 'Подтверди почту' }).waitFor({ timeout: 20_000 })
  await page.getByRole('textbox', { name: 'Код из письма' }).fill(await newestCode(ACCOUNT.email, before))
  await page.waitForURL('**/home', { timeout: 30_000 })
}

const userId = await page.evaluate(() => JSON.parse(localStorage.getItem('ryadom.user') ?? 'null')?.id ?? null)
if (!userId) throw new Error('signed in, but no user id in storage')

const count = await seedJournal(AGENT, userId)

await mkdir(dirname(STATE), { recursive: true })
await context.storageState({ path: STATE })
await browser.close()
console.log(`${ACCOUNT.email} / ${ACCOUNT.password}: ${count} conversations seeded for ${userId}; session in ${STATE}`)
