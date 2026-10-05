import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { findGlitches } from './glitches.mjs'

/**
 * The loop shared by every app: for each screen and width open a fresh browser context, bring the
 * screen up, let it settle, look for glitches, and only then take the picture.
 *
 * `spec`: { app, base, state?, heights(width, screen), screens, login?(browser, spec), reset?(),
 *           settle?(page), ctx }. A screen is { anon?, only?(width), reset?, fullPage?, open(page, ctx) }.
 */
export async function runShots(spec, args, repoRoot) {
  const widths = String(args.widths ?? spec.widths ?? '390,820,1280,1920').split(',').map(Number)
  const wanted = args.screens ? String(args.screens).split(',') : Object.keys(spec.screens)
  const out = resolve(String(args.out ?? join(repoRoot, 'screenshots')))
  const ignore = args.ignore ? String(args.ignore).split(',') : []
  const strict = Boolean(args.strict)
  const scale = Number(args.scale ?? 1)
  // A headless browser has no microphone: the fake device plays a tone, so the voice screen can listen.
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })

  if (args.login) {
    await spec.login(browser, spec)
    await browser.close()
    return 0
  }
  await mkdir(out, { recursive: true })

  let problems = 0
  for (const name of wanted) {
    const screen = spec.screens[name]
    if (!screen) {
      console.error(`unknown screen: ${name}`)
      problems++
      continue
    }
    for (const width of widths) {
      if (screen.only && !screen.only(width)) continue
      if (screen.reset && spec.reset) await spec.reset()
      const context = await browser.newContext({
        viewport: { width, height: spec.heights(width, screen) },
        locale: 'ru-RU',
        deviceScaleFactor: scale,
        reducedMotion: 'reduce',
        permissions: ['microphone'],
        ...(screen.anon || !spec.state ? {} : { storageState: spec.state }),
      })
      // A headless browser has no voice, and a real engine would make the pace of every shot depend on the machine.
      await context.addInitScript(() => {
        class Utterance {
          constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; this.onend = null; this.onerror = null; this.onboundary = null }
        }
        const synthesis = { speak: (u) => setTimeout(() => u.onend?.(), 20), cancel() {}, getVoices: () => [] }
        Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true })
        window.SpeechSynthesisUtterance = Utterance
      })
      if (spec.prepareContext) await spec.prepareContext(context)
      const page = await context.newPage()
      const errors = []
      page.on('console', (message) => {
        const text = message.text()
        if (message.type() === 'error' && !/401|Failed to load resource|favicon/.test(text)) errors.push(`console: ${text.slice(0, 140)}`)
      })
      page.on('pageerror', (error) => errors.push(`pageerror: ${String(error.message).slice(0, 140)}`))
      const label = `${spec.app}-${name}-${width}`
      try {
        await screen.open(page, spec.ctx)
        await (spec.settle ?? defaultSettle)(page)
        const glitches = await findGlitches(page, { fullPage: !!screen.fullPage, ignore })
        const notes = [...glitches.map((g) => `GLITCH ${g.kind}: ${g.text}`), ...errors]
        if (glitches.length) problems++
        if (strict && glitches.length) {
          console.log(`${label}  NOT SAVED\n    ${notes.join('\n    ')}`)
        } else {
          await page.screenshot({ path: join(out, `${label}.png`), fullPage: !!screen.fullPage })
          console.log(notes.length ? `${label}\n    ${notes.join('\n    ')}` : label)
        }
      } catch (error) {
        problems++
        console.error(`${label}  FAILED: ${String(error.message).split('\n')[0]}`)
      } finally {
        await context.close()
      }
    }
  }
  if (spec.finish) await spec.finish(wanted.map((n) => spec.screens[n]))
  await browser.close()
  console.log(`${problems ? problems + ' screen(s) with problems' : 'ok'}; shots in ${out}`)
  return problems ? 1 : 0
}

const defaultSettle = async (page) => {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)
}
