import { mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { seedJournal, ACCOUNT } from '../demo-data.mjs'
import { standUrls } from './stand.mjs'

/** apps/mobile: the Framework7 client (PWA build served by vite), on the demo account. */
export function mobileSpec(args, repoRoot) {
  const urls = standUrls(args)
  const base = String(args.base ?? urls.pwa).replace(/\/$/, '')
  const agent = String(args.agent ?? urls.mock)
  const state = resolve(String(args.state ?? join(repoRoot, '.playwright-mcp', 'mobile-state.json')))

  const userId = () => {
    const saved = JSON.parse(readFileSync(state, 'utf8'))
    for (const origin of saved.origins ?? []) {
      const raw = origin.localStorage?.find((entry) => /ryadom\.user$/.test(entry.name))?.value
      if (raw) return JSON.parse(raw).id
    }
    throw new Error('no user in the saved session: run  ui-shots.mjs --app mobile --login')
  }
  const reset = () => seedJournal(agent, userId())

  const dismissBanner = async (page) => {
    const hide = page.getByRole('button', { name: 'Скрыть' })
    if (await hide.isVisible().catch(() => false)) await hide.click()
  }
  const welcome = async (page) => {
    await page.goto(`${base}/`)
    await page.waitForSelector('.page-current input[name="email"]', { timeout: 30_000 })
    await dismissBanner(page)
  }
  const home = async (page) => {
    await page.goto(`${base}/`)
    await page.waitForSelector('#rd-tabbar', { state: 'visible', timeout: 30_000 })
    await dismissBanner(page)
  }
  const tab = async (page, label) => {
    await page.locator('#rd-tabbar').getByText(label, { exact: true }).click()
  }
  const send = async (page, text) => {
    const composer = page.locator('.page-current .rd-dialog-bar textarea')
    await composer.waitFor({ timeout: 30_000 })
    // The screen can re-render between resolving the box and typing, leaving the send button disabled.
    for (let attempt = 0; attempt < 10; attempt++) {
      await composer.fill(text)
      const ready = await page
        .waitForFunction(() => { const b = document.querySelector('.page-current .rd-icon-button--primary'); return b && !b.disabled }, null, { timeout: 3000 })
        .then(() => true, () => false)
      if (ready) break
    }
    await page.locator('.page-current .rd-icon-button--primary').click({ timeout: 30_000 })
  }
  const received = (page, count) =>
    page.waitForFunction((n) => document.querySelectorAll('.message-received').length >= n, count, { timeout: 30_000 })
  // The conversation opens on the voice screen and starts listening (the fake microphone of the runner).
  const startVoice = async (page) => {
    await home(page)
    await page.locator('.page-current').getByText('Поговорить').first().click()
    await page.locator('.page-current .rd-voice').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Остановить запись' }).waitFor({ timeout: 30_000 })
  }
  // The text feed: a voice turn would put the mock's "[голосовая реплика]" into every picture, so these
  // screens come in without a microphone and the voice screen falls back to the text by itself.
  const startChat = async (page) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    })
    await home(page)
    await page.locator('.page-current').getByText('Поговорить').first().click()
    await page.locator('.page-current .rd-dialog-bar textarea').waitFor({ timeout: 30_000 })
    // The toast that explains the fall back is not part of the screen.
    await page.waitForSelector('.toast', { state: 'detached', timeout: 10_000 }).catch(() => {})
  }
  const voiceReply = async (page) => {
    await startVoice(page)
    await page.waitForTimeout(800)
    const caption = page.locator('.page-current [data-testid="voice-caption"]')
    const greeting = (await caption.textContent()) ?? ''
    await page.getByRole('button', { name: 'Остановить запись' }).click()
    // The mock answers a voice turn after a pause in the frames; the greeting is replaced by the reply,
    // which then streams in word by word.
    await page.waitForFunction(
      (before) => {
        const text = document.querySelector('.page-current [data-testid="voice-caption"]')?.textContent ?? ''
        const hint = document.querySelector('.page-current .rd-voice-hint')?.textContent ?? ''
        return text !== '' && text !== before && hint.startsWith('Нажми на шар')
      },
      greeting,
      { timeout: 30_000 },
    )
  }
  const chat = async (page) => {
    await startChat(page)
    await send(page, 'Сегодня было очень тяжело, поссорились с мамой')
    await received(page, 2)
    await send(page, 'Не знаю, как ей позвонить и что сказать')
    await received(page, 3)
    await page.waitForTimeout(600)
  }
  const openEnd = async (page) => {
    await page.getByRole('button', { name: 'Завершить разговор' }).click()
    await page.waitForSelector('text=Что забираешь с собой?')
  }
  const endSheet = async (page, { submit }) => {
    const sheet = page.locator('.sheet-modal.modal-in')
    await sheet.getByRole('textbox').fill('Поговорю с мамой после работы')
    await sheet.getByRole('button', { name: '4', exact: true }).click()
    if (submit) {
      await sheet.getByText('Завершить', { exact: true }).click()
      await page.waitForSelector('text=Спасибо, что поговорил(а)')
    }
  }

  const screens = {
    welcome: { anon: true, open: welcome },
    register: {
      anon: true,
      open: async (page) => {
        await welcome(page)
        await page.locator('.page-current').getByText('Создать аккаунт').click()
        await page.locator('.page-current input[name="name"]').fill('Женя')
        await page.locator('.page-current input[name="email"]').fill('zhenya@example.com')
        await page.locator('.page-current input[name="password"]').fill('Password-123')
      },
    },
    'confirm-email': {
      anon: true,
      open: async (page) => {
        await welcome(page)
        await page.locator('.page-current').getByText('Создать аккаунт').click()
        await page.locator('.page-current input[name="name"]').fill('Женя')
        await page.locator('.page-current input[name="email"]').fill(`shot-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`)
        await page.locator('.page-current input[name="password"]').fill('Password-123')
        await page.locator('.page-current .rd-consents .icon-checkbox').click()
        await page.locator('.page-current').getByText('Создать аккаунт').click()
        await page.waitForSelector('text=Подтверди почту', { timeout: 30_000 })
      },
    },
    home: { open: home },
    sos: {
      open: async (page) => {
        await home(page)
        await page.getByRole('button', { name: 'SOS' }).first().click()
        await page.waitForSelector('text=Если сейчас тяжело')
      },
    },
    people: {
      open: async (page) => {
        await home(page)
        await page.locator('.page-current').getByText('Посмотреть').first().click()
      },
    },
    journal: { open: async (page) => { await home(page); await tab(page, 'Журнал') } },
    'journal-entry': {
      open: async (page) => {
        await home(page)
        await tab(page, 'Журнал')
        await page.locator('.page-current').getByText('Поговорю с мамой после работы').first().click()
      },
    },
    profile: { open: async (page) => { await home(page); await tab(page, 'Профиль') } },
    delete: {
      open: async (page) => {
        await home(page)
        await tab(page, 'Профиль')
        await page.getByText('Стереть всё и удалить аккаунт').click()
        await page.waitForSelector('text=Это действие необратимо')
      },
    },
    // The voice screen, the way a conversation opens: the sphere listens.
    'dialog-voice': { reset: true, open: startVoice },
    // After a turn: the sphere is calm again and the reply is under it.
    'dialog-voice-reply': { reset: true, open: voiceReply },
    'dialog-empty': { reset: true, open: startChat },
    dialog: { reset: true, open: chat },
    'dialog-end': { reset: true, open: async (page) => { await chat(page); await openEnd(page) } },
    'dialog-end-filled': {
      reset: true,
      only: (width) => width === 390,
      open: async (page) => { await chat(page); await openEnd(page); await endSheet(page, { submit: false }) },
    },
    'dialog-summary': {
      reset: true,
      open: async (page) => { await chat(page); await openEnd(page); await endSheet(page, { submit: true }) },
    },
    'home-after-dialog': {
      reset: true,
      open: async (page) => {
        await chat(page)
        await openEnd(page)
        await endSheet(page, { submit: true })
        await page.getByRole('button', { name: 'ОК' }).click()
        await page.waitForSelector('#rd-tabbar', { state: 'visible', timeout: 20_000 })
      },
    },
  }

  return {
    app: 'mobile',
    base,
    state,
    screens,
    ctx: {},
    heights: (width) => ({ 390: 844, 820: 1180, 1280: 800, 1920: 1080 }[width] ?? 900),
    reset,
    // Framework7 slides pages; a picture taken mid-slide shows two screens at once.
    async settle(page) {
      await page.waitForFunction(() => !document.querySelector('.page-transitioning, .router-transition'), null, { timeout: 5000 }).catch(() => {})
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(900)
    },
    // Sign-in and code requests are limited per address: every context gets an address of its own.
    async prepareContext(context) {
      const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
      await context.route((url) => url.pathname.startsWith('/api/'), (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }))
    },
    async login(browser) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
      const page = await context.newPage()
      await page.goto(`${base}/`)
      await page.waitForSelector('.page-current input[name="email"]', { timeout: 30_000 })
      await page.locator('.page-current input[name="email"]').fill(ACCOUNT.email)
      await page.locator('.page-current input[name="password"]').fill(ACCOUNT.password)
      await page.locator('.page-current a.button-fill').first().click()
      await page.waitForSelector('#rd-tabbar', { timeout: 30_000 })
      await mkdir(dirname(state), { recursive: true })
      await context.storageState({ path: state })
      console.log(`signed in as ${ACCOUNT.email}; session kept in ${state}`)
    },
    async finish(used) {
      if (used.some((screen) => screen?.reset) && existsSync(state)) await reset()
    },
  }
}
