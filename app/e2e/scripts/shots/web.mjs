import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { seedJournal, ACCOUNT } from '../demo-data.mjs'
import { standUrls } from './stand.mjs'

/** apps/web: the signed-in product and its anonymous screens, on the demo account. */
export function webSpec(args, repoRoot) {
  const urls = standUrls(args)
  const base = String(args.base ?? urls.web).replace(/\/$/, '')
  const agent = String(args.agent ?? urls.mock)
  const state = resolve(String(args.state ?? join(repoRoot, '.playwright-mcp', 'web-state.json')))

  const userId = () => {
    const saved = JSON.parse(readFileSync(state, 'utf8'))
    for (const origin of saved.origins ?? []) {
      // The web client keeps its own namespace (`ryadom.web.`) where the PWA and the apps share the origin.
      const raw = origin.localStorage?.find((entry) => entry.name === 'ryadom.web.user' || entry.name === 'ryadom.user')?.value
      if (raw) return JSON.parse(raw).id
    }
    throw new Error('no user in the saved session: run demo-account.mjs')
  }
  // A shot that starts a conversation leaves it open in the mock; the next one starts from the same journal.
  const reset = () => seedJournal(agent, userId())

  const go = (path) => async (page) => {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  }
  const flow = (kind, path) => async (page) => {
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
    await page.evaluate((value) => sessionStorage.setItem('ryadom.pending-auth', JSON.stringify(value)), { kind, email: 'anna@example.com' })
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  }
  /** A short, natural exchange from the home screen: two messages and the two answers to them. */
  const chat = async (page) => {
    await go('/home')(page)
    await page.getByTestId('home-input').fill('Сегодня было очень тяжело, поссорились с мамой')
    await page.getByTestId('home-talk').click()
    await page.waitForURL('**/dialog/**', { timeout: 20_000 })
    const messages = page.getByTestId('dialog-message')
    await messages.nth(2).waitFor({ timeout: 20_000 })
    await page.getByTestId('dialog-input').fill('Не знаю, как ей позвонить и что сказать')
    await page.getByTestId('dialog-send').click()
    await messages.nth(4).waitFor({ timeout: 20_000 })
    await page.waitForTimeout(1200)
  }
  // "Поговорить" with nothing typed opens the voice screen and starts listening (the runner's fake microphone).
  const startVoice = async (page) => {
    await go('/home')(page)
    await page.getByTestId('home-talk').click()
    await page.waitForURL('**/dialog/**', { timeout: 20_000 })
    // The conversation starts hands-free: it is listening as soon as the voice screen is up.
    await page.getByTestId('voice-caption').waitFor({ timeout: 30_000 })
  }
  // After one voice turn: the sphere is calm again and the reply is under it.
  const voiceReply = async (page) => {
    await startVoice(page)
    await page.waitForTimeout(800)
    const caption = page.getByTestId('voice-caption')
    const greeting = (await caption.textContent()) ?? ''
    // Hands-free: the fake microphone speaks, the turn ends by itself and the reply replaces the greeting; if it
    // does not come in time, the picture shows the voice screen as it is.
    await page
      .waitForFunction(
        (before) => (document.querySelector('[data-testid="voice-caption"]')?.textContent ?? '') !== before,
        greeting,
        { timeout: 20_000 },
      )
      .catch(() => {})
  }
  const openMenu = async (page) => {
    await page.getByRole('button', { name: 'Меню' }).first().click()
    await page.waitForTimeout(500)
  }

  const screens = {
    login: { anon: true, open: go('/login') },
    register: { anon: true, open: go('/register') },
    'forgot-password': { anon: true, open: go('/forgot-password') },
    'confirm-email': { anon: true, open: flow('confirm', '/confirm-email') },
    'reset-password': { anon: true, open: flow('reset', '/reset-password') },
    home: { open: go('/home') },
    sos: {
      open: async (page) => {
        await go('/home')(page)
        await page.getByRole('button', { name: 'SOS' }).first().click()
        await page.waitForTimeout(500)
      },
    },
    people: { open: go('/people') },
    journal: { open: go('/journal') },
    'journal-entry': {
      open: async (page) => {
        await go('/journal')(page)
        // A finished conversation: an open one resumes in the dialog screen instead of opening here.
        await page.locator('[data-testid="journal-item"][href^="/journal/"]').first().click()
        await page.waitForLoadState('networkidle')
      },
    },
    profile: { open: go('/profile') },
    'profile-change-password': { open: go('/profile/change-password') },
    'profile-delete-account': { open: go('/profile/delete') },
    // The shell's own states: the drawer on a phone, the account menu, the collapsed desktop sidebar.
    menu: { only: (width) => width < 768, open: async (page) => { await go('/home')(page); await openMenu(page) } },
    'account-menu': {
      open: async (page) => {
        await go('/home')(page)
        if (page.viewportSize().width < 768) await openMenu(page)
        await page.getByTestId('account-menu').click()
        await page.waitForTimeout(400)
      },
    },
    collapsed: { only: (width) => width >= 768, open: async (page) => { await go('/home')(page); await openMenu(page) } },
    // The conversation as it opens: the sphere listens. Typed words open the text instead (the shots below).
    'dialog-voice': { reset: true, open: startVoice },
    'dialog-voice-reply': { reset: true, open: voiceReply },
    dialog: { reset: true, open: chat },
    'dialog-end': {
      reset: true,
      open: async (page) => {
        await chat(page)
        await page.getByRole('button', { name: 'Завершить разговор' }).click()
        await page.waitForTimeout(800)
      },
    },
    'dialog-summary': {
      reset: true,
      open: async (page) => {
        await chat(page)
        await page.getByRole('button', { name: 'Завершить разговор' }).click()
        await page.getByTestId('takeaway-input').fill('Поговорю с мамой после работы')
        await page.getByTestId('tension-option').nth(3).click()
        await page.getByTestId('dialog-end-submit').click()
        await page.getByTestId('alert-text').waitFor({ timeout: 10_000 })
        await page.waitForTimeout(600)
      },
    },
  }

  return {
    app: 'web',
    base,
    state,
    screens,
    ctx: {},
    // Sign-in is limited per address: every context gets an address of its own.
    async prepareContext(context) {
      const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
      await context.route((url) => url.pathname.startsWith('/api/'), (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }))
    },
    // Every signed-in shot signs in on its own: the refresh token rotates, so one saved session cannot serve many contexts.
    async signIn(page) {
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
      await page.locator('input[name="email"]').fill(ACCOUNT.email)
      await page.locator('input[name="password"]').fill(ACCOUNT.password)
      await page.locator('form button[type="submit"]').first().click()
      await page.waitForURL('**/home', { timeout: 30_000 })
    },
    // The signed-in desktop window is 900px tall at 1280; everything else follows the usual sizes.
    heights: (width, screen) => (width === 1280 ? (screen.anon ? 800 : 900) : { 390: 844, 820: 1180, 1920: 1080 }[width] ?? 900),
    reset,
    async login(browser) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' })
      const page = await context.newPage()
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
      await page.locator('input[name="email"]').fill(ACCOUNT.email)
      await page.locator('input[name="password"]').fill(ACCOUNT.password)
      await page.locator('form button[type="submit"]').first().click()
      await page.waitForURL('**/home', { timeout: 20_000 })
      await mkdir(dirname(state), { recursive: true })
      await context.storageState({ path: state })
      console.log(`signed in as ${ACCOUNT.email}; session kept in ${state}`)
    },
    async finish(used) {
      // The last chat shot leaves a conversation open in the mock; the demo journal goes back to how it was.
      if (used.some((screen) => screen?.reset) && existsSync(state)) await reset()
    },
  }
}
