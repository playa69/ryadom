#!/usr/bin/env node
/**
 * Captures every screen of the web app (apps/web) at five widths into `review/web-*.png` for a
 * human (or Claude) to look at, and measures what a picture cannot show: horizontal overflow,
 * text that nearly touches the window edge, clipped text, a second SOS button, content hidden
 * under the tab pill or the rail, and policy violations or errors in the console.
 *
 * Not part of the test suite: the specs assert behaviour, this takes pictures. The landing's own
 * shots (`scripts/review-shots.mjs`) share the `web-` prefix, so this script only ever deletes the
 * files it writes itself.
 *
 * Usage: node e2e/scripts/review-web-shots.mjs   (needs the stack from scripts/stack.mjs running)
 */
import { chromium } from '@playwright/test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveStand } from '../../scripts/stand-ports.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(repoRoot, 'review')

// The addresses of this worktree's e2e stack (app/.stand.json; the old fixed ports without a slot).
const STACK = resolveStand().urls.e2e
const WEBAPP = process.env.E2E_WEBAPP_URL ?? STACK.web
const MAIL = process.env.E2E_MAIL_URL ?? STACK.mail

const DEFAULT_WIDTHS = [
  { name: '360', width: 360, height: 780 },
  { name: '414', width: 414, height: 896 },
  { name: '820', width: 820, height: 1180 }, // tablet (iPad Air portrait)
  { name: '1280', width: 1280, height: 900 },
  { name: '1920', width: 1920, height: 1080 },
]

/** REVIEW_WIDTHS="320x568,667x375" probes other windows (breakpoint edges, landscape phones). */
const WIDTHS = process.env.REVIEW_WIDTHS
  ? process.env.REVIEW_WIDTHS.split(',').map((spec) => {
      const [width, height] = spec.trim().split('x').map(Number)
      return { name: `${width}x${height}`, width, height }
    })
  : DEFAULT_WIDTHS

/** Names of the shots, so a re-run clears its own files and leaves the landing's alone. */
const SHOTS = [
  'login',
  'register',
  'confirm-email',
  'forgot-password',
  'reset-password',
  'home',
  'sos',
  'dialog',
  'dialog-end',
  'dialog-summary',
  'journal',
  'journal-entry',
  'people',
  'profile',
  'profile-change-password',
  'profile-delete-account',
  'failed',
]

/** One account for the whole run: requesting a code is rate limited per address and per IP. */
const account = { email: `review-web-${process.pid}@example.com`, password: 'review-Password-1' }
let registered = false
let checkedMasterDetail = false
/** Focus rings do not depend on the width: walked at the first width and once on a wide one. */
let focusPass = false
let wideFocused = false

const problems = []

/**
 * Sign-in and code entry are limited per IP; a fresh address per run (the API reads it from
 * X-Forwarded-For, as behind the ingress) lets the script be re-run while a layout is being fixed.
 */
const clientAddress = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`

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
    const over = Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth
    if (over <= 0) return null
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)
    return { over, wide }
  })
}

/**
 * Text that nearly touches a window edge reads as broken even when nothing overflows. Measured,
 * not eyeballed: eight pixels are hard to judge in a 1:1 screenshot.
 */
async function gutters(page, min) {
  return page.evaluate((minGap) => {
    const width = document.documentElement.clientWidth
    const offenders = []
    for (const el of document.querySelectorAll('h1,h2,h3,p,li,td,th,span,a,button,label,summary,time')) {
      if (!el.textContent.trim()) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue
      if (Number(style.opacity) === 0) continue
      // The rail hugs the window edge on purpose; fixed bars are skipped above.
      if (el.closest('.rd-nav, .rd-offline, .rd-skip')) continue
      // An off-screen box (a closed <dialog>) says nothing about the layout.
      if (el.closest('dialog:not([open])')) continue
      // Layout wrappers may span the full width; only boxes that paint at their edge and leaf
      // elements that hold text say anything about the visible margin.
      const paints = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(style.borderTopWidth) > 0
      if (!paints && el.children.length > 0) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // A modal sheet is a full-width panel on a phone by design.
      if (el.closest('dialog.rd-modal') && el.classList.contains('rd-modal')) continue
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

/** Text cut off by its own box: an element that clips horizontally and holds more than it shows. */
async function clipped(page) {
  return page.evaluate(() => {
    const found = []
    for (const el of document.querySelectorAll('h1,h2,h3,p,span,a,button,label,li,time')) {
      if (!el.textContent.trim()) continue
      if (el.closest('dialog:not([open]), .rd-sr-only')) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if (style.overflowX === 'visible') continue
      if (el.scrollWidth > el.clientWidth + 1) {
        found.push(
          `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${el.textContent.trim().slice(0, 30)}"`,
        )
      }
    }
    return found.slice(0, 5)
  })
}

/**
 * Text contrast against the nearest painted backgrounds (the glass surfaces are composited over the
 * page colour; the ambient bloom behind them is too faint to matter). WCAG AA: 4.5, or 3 for large text.
 */
async function lowContrast(page) {
  return page.evaluate(() => {
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a] = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number)
      return { r, g, b, a: a ?? 1 }
    }
    const blend = (top, bottom, alpha = top.a) => ({
      r: top.r * alpha + bottom.r * (1 - alpha),
      g: top.g * alpha + bottom.g * (1 - alpha),
      b: top.b * alpha + bottom.b * (1 - alpha),
      a: 1,
    })
    const channel = (v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const paper = { r: 11, g: 15, b: 20, a: 1 }
    const backdrop = (el) => {
      const layers = []
      for (let node = el; node; node = node.parentElement) {
        const bg = parse(getComputedStyle(node).backgroundColor)
        if (bg && bg.a > 0) {
          layers.push(bg)
          if (bg.a >= 1) break
        }
      }
      return layers.reverse().reduce((under, layer) => blend(layer, under), paper)
    }
    const found = []
    for (const el of document.querySelectorAll('body *')) {
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue
      if (el.closest('dialog:not([open]), .rd-sr-only, script, style')) continue
      // WCAG exempts inactive controls. The mode chips are checked anyway: their "скоро" is information.
      if (el.closest('button:disabled:not(.rd-home__mode)')) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      let opacity = 1
      for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
      const fg = parse(style.color)
      if (!fg) continue
      const bg = backdrop(el)
      const ink = blend(fg, bg, fg.a * opacity)
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      const need = large ? 3 : 4.5
      const got = ratio(ink, bg)
      if (got < need) {
        found.push(
          `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${el.textContent.trim().slice(0, 28)}" ${got.toFixed(2)}:1`,
        )
      }
    }
    return found.slice(0, 8)
  })
}

/** Touch targets on a phone or a tablet: every control at least 44px each way, bar links set in a sentence. */
async function smallTargets(page) {
  return page.evaluate(() => {
    const found = []
    for (const el of document.querySelectorAll('a[href], button, input, textarea, select, summary')) {
      if (el.closest('dialog:not([open]), .rd-sr-only, .rd-skip')) continue
      if (el.matches('input[type="checkbox"], input[type="radio"], input[type="hidden"]')) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.display === 'inline') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.width < 43.5 || r.height < 43.5) {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)
        found.push(
          `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${text}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        )
      }
    }
    return found.slice(0, 6)
  })
}

/** Signed-in chrome: one SOS on screen, content clear of the pill / the rail. */
async function chrome(page) {
  return page.evaluate(() => {
    const out = []
    const nav = document.querySelector('.rd-nav')
    if (!nav) return out
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
    }
    const sos = [...document.querySelectorAll('.rd-sos')].filter(visible)
    if (sos.length !== 1) out.push(`${sos.length} SOS buttons on screen`)
    const main = document.querySelector('.rd-main')
    const navBox = nav.getBoundingClientRect()
    if (visible(nav) && main) {
      const mainBox = main.getBoundingClientRect()
      const rail = navBox.height > window.innerHeight - 2
      if (rail && mainBox.left < navBox.right - 1)
        out.push(`main starts at ${Math.round(mainBox.left)}px under the ${Math.round(navBox.right)}px rail`)
    }
    return out
  })
}

/** The last thing on a phone page must clear the tab pill once scrolled to the end. */
async function clearOfTabs(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.rd-nav')
    const shell = document.querySelector('.rd-shell')
    if (!nav || !shell || shell.dataset.tabs === 'hidden') return null
    const navBox = nav.getBoundingClientRect()
    if (navBox.height > window.innerHeight - 2 || navBox.width === 0) return null
    window.scrollTo(0, document.documentElement.scrollHeight)
    let lowest = 0
    for (const el of document.querySelectorAll('.rd-main *')) {
      const s = getComputedStyle(el)
      if (s.position === 'fixed' || s.visibility === 'hidden' || s.display === 'none') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      lowest = Math.max(lowest, r.bottom)
    }
    window.scrollTo(0, 0)
    return lowest > navBox.top
      ? `content reaches ${Math.round(lowest)}px, the tab pill starts at ${Math.round(navBox.top)}px`
      : null
  })
}

/**
 * Walks the screen with Tab and reports every control that shows no focus ring. A global
 * `:focus-visible` rule is easy to lose to a component's own `box-shadow`, and that cannot be
 * seen in a screenshot because nothing is focused in one.
 */
async function checkFocus(page, name) {
  await page.evaluate(() => {
    document.activeElement?.blur()
    window.scrollTo(0, 0)
  })
  const missing = new Set()
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab')
    const step = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return { done: true }
      if (el.dataset.rdFocusSeen) return { done: true }
      el.dataset.rdFocusSeen = '1'
      const style = getComputedStyle(el)
      // The solid ring, not the translucent glow some buttons cast in the same colour.
      const blue = (value) => value.includes('rgb(77, 163, 255)')
      const ring =
        blue(style.boxShadow) ||
        (style.outlineStyle !== 'none' &&
          parseFloat(style.outlineWidth) > 0 &&
          !style.outlineColor.includes(', 0)')) ||
        // The composer's pill is the field's boundary and lights up in its place.
        (el.matches('[data-testid=dialog-input]') && blue(getComputedStyle(el.closest('form')).borderColor))
      const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '')
        .trim()
        .slice(0, 30)
      return {
        done: false,
        ring,
        label: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${text}"`,
      }
    })
    if (step.done) break
    if (!step.ring) missing.add(step.label)
  }
  for (const label of missing) problems.push(`${name}: no focus ring - ${label}`)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-rd-focus-seen]')) delete el.dataset.rdFocusSeen
    document.activeElement?.blur()
    window.scrollTo(0, 0)
  })
}

async function settle(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(500)
}

/**
 * Takes the picture and runs every measurement. `full` suits anonymous screens (nothing fixed on
 * them); signed-in ones are a viewport shot plus, when the page scrolls, a second one at the end,
 * because a full-page capture misplaces fixed bars.
 */
async function shoot(page, name, options = {}) {
  await settle(page)
  const over = await overflow(page)
  if (over) problems.push(`${name}: horizontal overflow ${over.over}px - ${over.wide.join(', ')}`)
  for (const t of await gutters(page, options.minGutter ?? 12)) {
    problems.push(`${name}: ${t.gap}px from the edge - ${t.tag}.${t.cls} "${t.text}"`)
  }
  for (const text of await clipped(page)) problems.push(`${name}: clipped text - ${text}`)
  for (const text of await lowContrast(page)) problems.push(`${name}: low contrast - ${text}`)
  if (page.viewportSize().width < 1024) {
    for (const text of await smallTargets(page)) problems.push(`${name}: small touch target - ${text}`)
  }
  if (!options.sheet) {
    for (const text of await chrome(page)) problems.push(`${name}: ${text}`)
  }
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: options.full ?? false })

  if (!options.full && !options.sheet) {
    const clear = await clearOfTabs(page)
    if (clear) problems.push(`${name}: ${clear}`)
    const scrolls = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight > 40)
    if (scrolls && options.end !== false) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(OUT, `${name}-end.png`) })
      await page.evaluate(() => window.scrollTo(0, 0))
    }
  }
  if (focusPass && !options.sheet) await checkFocus(page, name)
}

function watch(page, label) {
  page.on('pageerror', (error) => problems.push(`${label}: page error - ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    problems.push(`${label}: console error - ${message.text().slice(0, 160)}`)
  })
  return page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP ${event.violatedDirective} ${event.blockedURI}`)
    })
    // Against `next dev` its indicator sits over the rail's SOS button; it is not part of the page.
    new MutationObserver(() =>
      document.querySelectorAll('nextjs-portal').forEach((el) => el.remove()),
    ).observe(document, { childList: true, subtree: true })
  })
}

async function go(page, path) {
  await page.goto(`${WEBAPP}${path}`, { waitUntil: 'networkidle' })
}

async function seedFlow(page, kind, email) {
  await page.evaluate(
    ([k, e]) => sessionStorage.setItem('ryadom.pending-auth', JSON.stringify({ kind: k, email: e })),
    [kind, email],
  )
}

async function openTab(page, label) {
  await page
    .getByRole('navigation', { name: 'Основное' })
    .getByRole('link', { name: label, exact: true })
    .click()
}

await mkdir(OUT, { recursive: true })
// Only this run's own files: the landing's shots and other widths stay where they are.
const ours = new Set(
  SHOTS.flatMap((shot) =>
    WIDTHS.flatMap((size) => [`web-${shot}-${size.name}.png`, `web-${shot}-${size.name}-end.png`]),
  ),
)
for (const file of await readdir(OUT)) {
  if (ours.has(file)) await rm(join(OUT, file))
}

const browser = await chromium.launch()

for (const size of WIDTHS) {
  focusPass = size === WIDTHS[0] || (size.width >= 1024 && !wideFocused)
  if (size.width >= 1024) wideFocused = true
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    permissions: ['microphone'],
  })
  // A route, not `extraHTTPHeaders`: those would make the web app's calls to the API preflighted.
  await context.route(/\/api\//, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': clientAddress } }),
  )
  const page = await context.newPage()
  const at = (shot) => `web-${shot}-${size.name}`
  await watch(page, `@${size.name}`)

  try {
    // ── anonymous screens ──────────────────────────────────────────────────
    await go(page, '/login')
    await shoot(page, at('login'), { full: true })

    await page.getByRole('link', { name: 'Создать аккаунт', exact: true }).click()
    await page.getByRole('heading', { name: 'Давай знакомиться' }).waitFor()
    await shoot(page, at('register'), { full: true })

    await go(page, '/forgot-password')
    await shoot(page, at('forgot-password'), { full: true })

    // These two steps only need the flow state the previous screen would have left in the tab.
    await seedFlow(page, 'reset', account.email)
    await go(page, '/reset-password')
    await page.getByRole('heading', { name: 'Код и новый пароль' }).waitFor()
    await shoot(page, at('reset-password'), { full: true })

    // ── sign-up once, sign-in at the other widths ──────────────────────────
    if (!registered) {
      await go(page, '/register')
      await page.locator('input[name="name"]').fill('Обзор')
      await page.locator('input[name="email"]').fill(account.email)
      await page.locator('input[name="password"]').fill(account.password)
      await page.getByTestId('consents').getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click()
      await page.getByRole('heading', { name: 'Подтверди почту' }).waitFor({ timeout: 30_000 })
      await shoot(page, at('confirm-email'), { full: true })
      await page.getByRole('textbox', { name: 'Код из письма' }).fill(await waitForCode(account.email))
      registered = true
    } else {
      await seedFlow(page, 'confirm', account.email)
      await go(page, '/confirm-email')
      await page.getByRole('heading', { name: 'Подтверди почту' }).waitFor()
      await shoot(page, at('confirm-email'), { full: true })

      await go(page, '/login')
      await page.locator('input[name="email"]').fill(account.email)
      await page.locator('input[name="password"]').fill(account.password)
      await page.getByRole('button', { name: 'Войти', exact: true }).click()
    }
    await page.getByTestId('home-talk').waitFor({ timeout: 30_000 })
    await shoot(page, at('home'))

    // ── SOS ────────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'SOS', exact: true }).click()
    await page.getByRole('heading', { name: 'Если сейчас тяжело' }).waitFor()
    await shoot(page, at('sos'), { sheet: true })
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()
    await page.waitForTimeout(300)

    // ── the conversation ───────────────────────────────────────────────────
    // One stubborn screen must not cost the whole run: this script exists to produce pictures.
    try {
      await page.getByTestId('home-talk').click()
      const input = page.getByPlaceholder('Напиши, что происходит')
      await input.waitFor({ timeout: 30_000 })
      // A resumed conversation already holds earlier replies: wait for one more than there is now.
      const replies = page.locator('[data-testid="dialog-message"][data-role="assistant"]')
      await replies.first().waitFor({ timeout: 30_000 })
      const before = await replies.count()
      await input.fill('Сегодня было очень тяжело')
      await page.getByRole('button', { name: 'Отправить' }).click()
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="dialog-message"][data-role="assistant"]').length > n,
        before,
        { timeout: 30_000 },
      )
      await page.locator('[data-streaming="true"]').waitFor({ state: 'detached', timeout: 30_000 })
      await shoot(page, at('dialog'), { end: false })

      await page.getByRole('button', { name: 'Завершить разговор', exact: true }).click()
      await page.getByRole('heading', { name: 'Что забираешь с собой?' }).waitFor()
      await shoot(page, at('dialog-end'), { sheet: true })

      if (size === WIDTHS[0]) {
        // Once, so the journal has an entry to show: the later widths find it already there.
        await page.getByTestId('takeaway-input').fill('Стало чуть легче')
        await page.getByRole('dialog').getByRole('button', { name: '4', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Завершить', exact: true }).click()
        await page.getByRole('heading', { name: 'Спасибо, что поговорил(а)' }).waitFor({ timeout: 30_000 })
        await shoot(page, at('dialog-summary'), { sheet: true })
        await page.getByTestId('alert-ok').click()
        await page.getByTestId('home-talk').waitFor()
      } else {
        await page.getByRole('button', { name: 'Продолжить разговор', exact: true }).click()
        await page.waitForTimeout(300)
        await page.getByRole('link', { name: 'Назад' }).click()
        await page.getByTestId('home-talk').waitFor()
      }
    } catch (error) {
      problems.push(`${at('dialog')}: could not drive the conversation - ${String(error).split('\n')[0]}`)
      await shoot(page, at('dialog'), { end: false })
      await go(page, '/home')
    }

    // ── journal ────────────────────────────────────────────────────────────
    await openTab(page, 'Журнал')
    await page.getByTestId('journal-item').first().waitFor({ timeout: 30_000 })
    await shoot(page, at('journal'))
    // The conversation that was ended has a title and themes; the ones left open are plain rows.
    const ended = page.getByTestId('journal-item').filter({ has: page.locator('.rd-journal-row__themes') })
    await ((await ended.count()) > 0 ? ended : page.getByTestId('journal-item')).first().click()
    await page.getByTestId('journal-message').first().waitFor({ timeout: 20_000 })
    await shoot(page, at('journal-entry'))

    if (size.width >= 1024 && !checkedMasterDetail) {
      checkedMasterDetail = true
      await checkMasterDetail(page)
    }

    // ── profile and what hangs off it ──────────────────────────────────────
    await openTab(page, 'Профиль')
    await page.getByTestId('profile-email').waitFor()
    await shoot(page, at('profile'))

    await page.getByTestId('row-people').click()
    await page.getByTestId('hotline').first().waitFor()
    await shoot(page, at('people'))

    await openTab(page, 'Профиль')
    await page.getByTestId('row-change-password').click()
    await page.getByRole('heading', { name: 'Изменить пароль' }).waitFor()
    await shoot(page, at('profile-change-password'))

    await openTab(page, 'Профиль')
    // Opened, not confirmed: the account is shared by every width in this run.
    await page.getByTestId('row-delete-account').click()
    await page.getByText('Это действие необратимо').waitFor()
    await shoot(page, at('profile-delete-account'))
  } catch (error) {
    problems.push(`@${size.name}: run stopped - ${String(error).split('\n')[0]}`)
    await page.screenshot({ path: join(OUT, `web-failed-${size.name}.png`) }).catch(() => {})
  }

  await context.close()
}

/**
 * The open journal entry must survive a resize across 1024px: an entry open in the pane at 1280
 * is its own screen at 414, and widening again puts the same entry back in the pane.
 */
async function checkMasterDetail(page) {
  const title = (await page.getByTestId('journal-pane').getByRole('heading').first().textContent())?.trim()
  const id = page.url()
  const label = 'master-detail'
  const idPart = (url) => decodeURIComponent(new URL(url).pathname.split('/')[2] ?? '')

  // The pane is opened by a click that does not navigate; the narrow route has the id in the URL.
  await page.setViewportSize({ width: 414, height: 896 })
  try {
    await page.waitForURL(/\/journal\/[^/]+$/, { timeout: 10_000 })
    const heading = (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim()
    if (heading !== title) problems.push(`${label}: narrow screen shows "${heading}" instead of "${title}"`)
    const narrowId = idPart(page.url())

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.waitForURL(/\/journal$/, { timeout: 10_000 })
    await page.getByTestId('journal-pane').waitFor({ timeout: 10_000 })
    const back = (await page.getByTestId('journal-pane').getByRole('heading').first().textContent())?.trim()
    if (back !== title) problems.push(`${label}: wide pane shows "${back}" instead of "${title}"`)
    const selected = page.locator('[data-testid="journal-item"][aria-current="true"]')
    if ((await selected.count()) !== 1) problems.push(`${label}: no selected row after widening`)
    console.log(`master-detail ok: "${title}" (${narrowId || id})`)
  } catch (error) {
    problems.push(`${label}: ${String(error).split('\n')[0]}`)
  }
}

await browser.close()

if (problems.length) {
  console.log('\nPROBLEMS')
  for (const p of problems) console.log(' -', p)
} else {
  console.log('\nno overflow, tight gutters, clipping or console errors at any width')
}
console.log(`\nshots in ${OUT}`)
process.exitCode = problems.length ? 1 : 0
