import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { newestCode, newestId } from './mail.mjs'

const ADMIN_EMAIL = 'admin@ryadom.local'

/** apps/admin: an internal desktop tool; signs in with a one-time code from Mailpit, once. */
export function adminSpec(args, repoRoot) {
  const base = String(args.base ?? 'http://localhost:3021').replace(/\/$/, '')
  const mail = String(args.mail ?? 'http://localhost:8026')
  const state = resolve(String(args.state ?? join(repoRoot, '.playwright-mcp', 'admin-state.json')))

  const go = (path) => async (page) => {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  }
  const screens = {
    login: { anon: true, open: go('/login') },
    'login-code': {
      anon: true,
      open: async (page) => {
        await go('/login')(page)
        await page.locator('input[name="email"]').fill(ADMIN_EMAIL)
        await page.locator('form button[type="submit"]').first().click()
        await page.locator('input[name="code"]').waitFor({ timeout: 15_000 })
      },
    },
    users: { open: go('/users') },
    'user-card': {
      open: async (page) => {
        await go('/users')(page)
        await page.locator('a[href^="/users/"]').first().click()
        // A dev server compiles the card on the first visit: wait for the page itself, not for a quiet network.
        await page.waitForURL(/\/users\/[^/?]+$/, { timeout: 30_000 })
        await page.waitForLoadState('networkidle')
      },
    },
    audit: { open: go('/audit') },
  }

  return {
    app: 'admin',
    base,
    state,
    screens,
    ctx: {},
    widths: '1280,1920',
    heights: (width) => (width === 1920 ? 1080 : 800),
    async login(browser) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' })
      const page = await context.newPage()
      const before = await newestId(mail, ADMIN_EMAIL)
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
      await page.locator('input[name="email"]').fill(ADMIN_EMAIL)
      await page.locator('form button[type="submit"]').first().click()
      await page.locator('input[name="code"]').waitFor({ timeout: 15_000 })
      await page.locator('input[name="code"]').fill(await newestCode(mail, ADMIN_EMAIL, before))
      await page.locator('form button[type="submit"]').first().click()
      await page.waitForURL('**/users', { timeout: 20_000 })
      await mkdir(dirname(state), { recursive: true })
      await context.storageState({ path: state })
      console.log(`signed in as ${ADMIN_EMAIL}; session kept in ${state}`)
    },
  }
}
